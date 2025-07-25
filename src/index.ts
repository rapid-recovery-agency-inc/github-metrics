import {Octokit} from "octokit";
import dotenv from "dotenv";
import xlsx from "xlsx";
import fetch from 'node-fetch';
import {getDateIntervals, handleRateLimit} from "./utils.js";
import {
    AggregateMetrics,
    GraphQLReview,
    GraphQLReviewNode,
    GraphQLReviewThread,
    GraphQLReviewThreadNode,
    RestIssueAndPullRequest,
    RestIssue,
    IssueEvent,
    LabelMetrics,
    ReviewsForPullRequest
} from "./types";
import {sendTemplateEmail} from "./email.js";
import {PRS_CACHE, PRS_REVIEW_CACHE, ISSUES_CACHE, ISSUE_EVENTS_CACHE, cleanupAllCaches, closeAllCaches} from "./cache.js";
import {AUTHOR_ALIAS_MAP, BLACKLISTED_CODE_USERS, DAYS_IN_INTERVAL, GITHUB_GRAPHQL_API} from "./constants";
import {aggregateCommits, fetchCommitsInDateRange} from "./commits";
import {debugToFile} from "./debug";
import {fetchRepositories} from "./repositories";


dotenv.config();

interface RankedUser {
    user: string;
    totalIndex: number;
}

interface LabelFrequency {
    labelName: string;
    frequency: number;
    repositories: string[];
}

const FILE_PATH = "GitHub_Metrics_Report.xlsx";
const LABELS_FILE_PATH = "GitHub_Labels_Report.xlsx";
// Initialize Octokit instance with GitHub token
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

// The PERIODS to generate reports for
const PERIODS: Record<number, string> = {
    2: "Last 2 Weeks",
    4: "Last 4 Weeks",
    6: "Last 6 Weeks",
    12: "Last 12 Weeks",
};

const MAX_RETRIES = 3;


// Function to fetch all pull requests within a given date range using date intervals
async function fetchPullRequestsInDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
) {
    const allPullRequests: RestIssueAndPullRequest[] = [];
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    for (const {since, until} of dateIntervals) {
        const cacheKey = `${repoOwner}-${since}-${until}`;
        const cachedResult = PRS_CACHE.get<RestIssueAndPullRequest[]>(cacheKey);
        if (cachedResult) {
            allPullRequests.push(...cachedResult);
            continue;
        }
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            try {
                const response = await octokit.rest.search.issuesAndPullRequests({
                    q: `org:${repoOwner} type:pr is:merged created:${since}..${until}`,
                    per_page: 100,
                    page,
                });
                // Handle rate limiting
                await handleRateLimit(response);
                allPullRequests.push(...response.data.items);

                // Check if there are more pages
                hasMore = response.data.items.length === 100;
                PRS_CACHE.set(cacheKey, response.data.items);
                page += 1;
            } catch (error: any) {
                if (error.status === 403) {
                    await handleRateLimit(error.response);
                } else {
                    throw error;
                }
            }
        }
    }
    return allPullRequests;
}

async function fetchReviewsForPR(
    repoOwner: string,
    repoName: string,
    prNumber: number
): Promise<ReviewsForPullRequest> {
    const allReviews: GraphQLReview[] = [];
    const allReviewThreads: GraphQLReviewThread[] = [];
    const cacheKey = `${repoOwner}-${repoName}-${prNumber}`;
    const cachedResult = PRS_REVIEW_CACHE.get<ReviewsForPullRequest>(cacheKey);
    if (cachedResult) {
        return {...cachedResult};
    }
    let cursor: string | null = null;
    let hasMore = true;
    while (hasMore) {
        const query = `
              query($owner: String!, $repo: String!, $pullNumber: Int!, $cursor: String) {
                repository(owner: $owner, name: $repo) {
                  pullRequest(number: $pullNumber) {
                    reviews(first: 100, after: $cursor) {
                      edges {
                        node {
                          author {
                            login
                          }
                          body
                          createdAt
                          state
                          commit {
                            oid
                          }
                        }
                      }
                      pageInfo {
                        hasNextPage
                        endCursor
                      }
                    }
                    reviewThreads(first: 100) {
                      edges {
                        node {
                          id
                          comments(first: 100) {
                            edges {
                              node {
                                author {
                                  login
                                }
                                body
                                createdAt
                              }
                            }
                          }
                          isResolved
                        }
                      }
                    }
                  }
                }
              }
            `;
        const variables = {
            owner: repoOwner,
            repo: repoName,
            pullNumber: prNumber,
            cursor
        };

        let retries = MAX_RETRIES;
        let success = false;
        while (retries > 0 && !success) {
            try {
                const response = await fetch(GITHUB_GRAPHQL_API, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
                    },
                    body: JSON.stringify({query, variables})
                });

                // Handle rate limiting
                await handleRateLimit(response);

                const result: any = await response.json();

                if (result.errors) {
                    console.error("GraphQL errors:fetchReviewsForPR:", result.errors);
                    throw new Error("GraphQL query failed");
                }

                const reviews: GraphQLReviewNode = result.data.repository.pullRequest.reviews;
                const reviewThreads: GraphQLReviewThreadNode = result.data.repository.pullRequest.reviewThreads;

                allReviews.push(...reviews.edges.map((edge: any) => edge.node));
                allReviewThreads.push(...reviewThreads.edges.map((edge: any) => edge.node));

                // Check if there are more reviews to fetch
                hasMore = reviews.pageInfo.hasNextPage;
                cursor = reviews.pageInfo.endCursor;

                success = true;

            } catch (error: any) {
                retries--;

                if (retries === 0) {
                    throw new Error("Failed after multiple retries");
                }

                const retryWaitTime = (MAX_RETRIES - retries) * 1000;
                await new Promise(resolve => setTimeout(resolve, retryWaitTime));
            }
        }
    }

    PRS_REVIEW_CACHE.set(cacheKey, {reviews: allReviews, reviewThreads: allReviewThreads});
    return {reviews: allReviews, reviewThreads: allReviewThreads};
}

// Function to categorize labels
function categorizeLabel(labelName: string): 'bug' | 'enhancement' | 'other' {
    const lowerCaseName = labelName.toLowerCase();
    if (lowerCaseName.includes('bug') || lowerCaseName.includes('fix') || lowerCaseName.includes('error')) {
        return 'bug';
    }
    if (lowerCaseName.includes('enhancement') || lowerCaseName.includes('feature') || 
        lowerCaseName.includes('improvement') || lowerCaseName.includes('enhancement')) {
        return 'enhancement';
    }
    return 'other';
}

// Function to fetch all issues within a given date range
async function fetchIssuesInDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
): Promise<RestIssue[]> {
    const allIssues: RestIssue[] = [];
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    
    for (const {since, until} of dateIntervals) {
        const cacheKey = `${repoOwner}-issues-${since}-${until}`;
        const cachedResult = ISSUES_CACHE.get<RestIssue[]>(cacheKey);
        if (cachedResult) {
            allIssues.push(...cachedResult);
            continue;
        }
        
        let page = 1;
        let hasMore = true;
        const intervalIssues: RestIssue[] = [];
        
        while (hasMore) {
            try {
                const response = await octokit.rest.search.issuesAndPullRequests({
                    q: `org:${repoOwner} type:issue created:${since}..${until}`,
                    per_page: 100,
                    page,
                });
                
                await handleRateLimit(response);
                intervalIssues.push(...response.data.items.filter((item: any) => !item.pull_request) as RestIssue[]);
                
                hasMore = response.data.items.length === 100;
                page += 1;
            } catch (error: any) {
                if (error.status === 403) {
                    await handleRateLimit(error.response);
                } else {
                    throw error;
                }
            }
        }
        
        ISSUES_CACHE.set(cacheKey, intervalIssues);
        allIssues.push(...intervalIssues);
    }
    
    return allIssues;
}

// Function to fetch label events for an issue
async function fetchLabelEventsForIssue(
    repoOwner: string,
    repoName: string,
    issueNumber: number,
    startDate: Date,
    endDate: Date
): Promise<IssueEvent[]> {
    const cacheKey = `${repoOwner}-${repoName}-issue-${issueNumber}-events`;
    const cachedResult = ISSUE_EVENTS_CACHE.get<IssueEvent[]>(cacheKey);
    if (cachedResult) {
        return cachedResult.filter(event => {
            const eventDate = new Date(event.created_at);
            return eventDate >= startDate && eventDate <= endDate;
        });
    }
    
    try {
        const response = await octokit.rest.issues.listEvents({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
            per_page: 100,
        });
        
        await handleRateLimit(response);
        
        const labelEvents = response.data.filter((event: any) => event.event === 'labeled') as IssueEvent[];
        ISSUE_EVENTS_CACHE.set(cacheKey, labelEvents);
        
        return labelEvents.filter(event => {
            const eventDate = new Date(event.created_at);
            return eventDate >= startDate && eventDate <= endDate;
        });
    } catch (error: any) {
        console.error(`Error fetching label events for issue ${issueNumber}:`, error);
        return [];
    }
}

// Function to aggregate label metrics by repository
async function aggregateLabelMetricsByRepo(
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<Record<string, LabelMetrics>> {
    const repoLabelMetrics: Record<string, LabelMetrics> = {};
    
    const issues = await fetchIssuesInDateRange(repoOwner, startDate, endDate);
    
    for (const issue of issues) {
        const repoName = issue.repository_url.split("/").pop() || "unknown";
        
        if (!repoLabelMetrics[repoName]) {
            repoLabelMetrics[repoName] = {
                bugLabels: 0,
                enhancementLabels: 0,
                otherLabels: 0,
            };
        }
        
        // Get label events for this issue in the date range
        const labelEvents = await fetchLabelEventsForIssue(repoOwner, repoName, issue.number, startDate, endDate);
        
        for (const event of labelEvents) {
            if (event.label) {
                const category = categorizeLabel(event.label.name);
                switch (category) {
                    case 'bug':
                        repoLabelMetrics[repoName].bugLabels += 1;
                        break;
                    case 'enhancement':
                        repoLabelMetrics[repoName].enhancementLabels += 1;
                        break;
                    case 'other':
                        repoLabelMetrics[repoName].otherLabels += 1;
                        break;
                }
            }
        }
    }
    
    return repoLabelMetrics;
}

// Function to count issues created by repository
async function getIssuesCreatedByRepo(
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<Record<string, number>> {
    const repoIssueCount: Record<string, number> = {};
    
    const issues = await fetchIssuesInDateRange(repoOwner, startDate, endDate);
    
    for (const issue of issues) {
        const repoName = issue.repository_url.split("/").pop() || "unknown";
        if (!repoIssueCount[repoName]) {
            repoIssueCount[repoName] = 0;
        }
        repoIssueCount[repoName] += 1;
    }
    
    return repoIssueCount;
}

// Function to aggregate metrics for a specific date range
const aggregateMetricsByDateRange = async (
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<Record<string, AggregateMetrics>> => {
    const rawUserMetrics: Record<string, AggregateMetrics> = {};
    const commits = await fetchCommitsInDateRange(repoOwner, repositories, startDate, endDate);
    const pullRequests = await fetchPullRequestsInDateRange(
        repoOwner,
        startDate,
        endDate
    );
    const repoLabelMetrics = await aggregateLabelMetricsByRepo(repoOwner, repositories, startDate, endDate);
    const aggregatedCommits = aggregateCommits(commits);
    
    Object.entries(aggregatedCommits).forEach(([author, data]) => {
        rawUserMetrics[author] = {
            commits: data.additions + data.deletions,
            pullRequests: 0,
            reviews: 0,
            rejections: 0,
            score: 0,
            bugLabels: 0,
            enhancementLabels: 0,
            otherLabels: 0,
        };
    });
    
    for (const pr of pullRequests) {
        const author = pr.user?.login || "Unknown";
        const repoName = `${pr.repository_url.split("/").pop()}`;
        rawUserMetrics[author] = rawUserMetrics[author] || {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            rejections: 0,
            score: 0,
            bugLabels: 0,
            enhancementLabels: 0,
            otherLabels: 0,
        };
        // Increment the number of PRs raised
        rawUserMetrics[author].pullRequests += 1;
        // Fetch reviews for the current PR
        const {reviews, reviewThreads} = await fetchReviewsForPR(repoOwner, repoName, pr.number);
        
        reviews.forEach((review) => {
            const reviewer = review.author?.login || "Unknown";
            
            rawUserMetrics[reviewer] = rawUserMetrics[reviewer] || {
                commits: 0,
                pullRequests: 0,
                reviews: 0,
                rejections: 0,
                score: 0,
                bugLabels: 0,
                enhancementLabels: 0,
                otherLabels: 0,
            };
            // Increment the number of reviews by the user
            rawUserMetrics[reviewer].reviews += 1;
            
            // Check if this review is a rejection (CHANGES_REQUESTED)
            if (review.state === 'CHANGES_REQUESTED') {
                rawUserMetrics[reviewer].rejections += 1;
            }
            
            // Add 1 point for the review
            rawUserMetrics[reviewer].score += 1;

            reviewThreads.forEach((reviewThread) => {
                const threadAuthor = reviewThread?.comments?.edges[0]?.node?.author?.login ?? 'Unknown';
                
                rawUserMetrics[threadAuthor] = rawUserMetrics[threadAuthor] || {
                    commits: 0,
                    pullRequests: 0,
                    reviews: 0,
                    rejections: 0,
                    score: 0,
                    bugLabels: 0,
                    enhancementLabels: 0,
                    otherLabels: 0,
                };
                rawUserMetrics[threadAuthor].score += 0.1;
            })
        });
    }
    
    const mergedUserMetrics: Record<string, AggregateMetrics> = {};
    Object.entries(rawUserMetrics).forEach(([author, data]) => {
        const normalizedAuthor = author.toLowerCase();
        if (BLACKLISTED_CODE_USERS.has(author)) { // Ignore metrics for blacklisted users
            return;
        }
        const aliasAuthor = AUTHOR_ALIAS_MAP.get(normalizedAuthor);
        const realAuthor = aliasAuthor ?? normalizedAuthor;
        const record = mergedUserMetrics[realAuthor] ?? {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            rejections: 0,
            score: 0,
            bugLabels: 0,
            enhancementLabels: 0,
            otherLabels: 0,
        };
        record.commits += data.commits;
        record.pullRequests += data.pullRequests;
        record.reviews += data.reviews;
        record.rejections += data.rejections;
        record.score += data.score;
        record.bugLabels += data.bugLabels;
        record.enhancementLabels += data.enhancementLabels;
        record.otherLabels += data.otherLabels;
        mergedUserMetrics[realAuthor] = record;
    });
    
    return mergedUserMetrics;
}

// Function to send an email with the reports attached
async function sendEmailWithAttachments(attachment: Buffer, aggregateRanking: RankedUser[], labelsReportPath?: string) {
    const rankedListString = aggregateRanking.map((rank, index) => {
        return `${index + 1}.  ${rank.user} <br/>`;
    }).join('\n');
    
    const attachments = [
        {
            filename: FILE_PATH,
            path: FILE_PATH,
        }
    ];
    
    // Add labels report if it exists
    if (labelsReportPath) {
        attachments.push({
            filename: LABELS_FILE_PATH,
            path: labelsReportPath,
        });
    }
    
    await sendTemplateEmail({
        users: [
            {email: 'alacret@insightt.io'},
            {email: 'ysouki@insightt.io'},
            {email: 'ezabala@insightt.io'},
            {email: 'lpena@insightt.io'}
        ],
        subject: "GitHub Metrics Report",
        body: `${rankedListString}<br/><br/>Note: Labels report is included as a separate attachment.`,
        attachments: attachments

    });
    console.log(`Email sent with ${attachments.length} attachments`);
}

// Function to get all label counts by repository
async function getDetailedLabelMetricsByRepo(
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<{
    repoMetrics: Record<string, Record<string, number>>;
    otherLabels: string[];
    issuesCreatedByRepo: Record<string, number>;
}> {
    const repoLabelMetrics: Record<string, Record<string, number>> = {};
    const allOtherLabels = new Set<string>();
    const issuesCreatedByRepo: Record<string, number> = {};
    
    const issues = await fetchIssuesInDateRange(repoOwner, startDate, endDate);
    
    for (const issue of issues) {
        const repoName = issue.repository_url.split("/").pop() || "unknown";
        
        // Count issues created
        if (!issuesCreatedByRepo[repoName]) {
            issuesCreatedByRepo[repoName] = 0;
        }
        issuesCreatedByRepo[repoName] += 1;
        
        if (!repoLabelMetrics[repoName]) {
            repoLabelMetrics[repoName] = {
                'Bug label': 0,
                'Enhancement label': 0,
            };
        }
        
        // Get label events for this issue in the date range
        const labelEvents = await fetchLabelEventsForIssue(repoOwner, repoName, issue.number, startDate, endDate);
        
        // Process label events
        for (const event of labelEvents) {
            if (event.label) {
                const labelName = event.label.name;
                const category = categorizeLabel(labelName);
                
                if (category === 'bug') {
                    repoLabelMetrics[repoName]['Bug label'] += 1;
                } else if (category === 'enhancement') {
                    repoLabelMetrics[repoName]['Enhancement label'] += 1;
                } else {
                    // This is an "other" label - track it individually
                    allOtherLabels.add(labelName);
                    if (!repoLabelMetrics[repoName][labelName]) {
                        repoLabelMetrics[repoName][labelName] = 0;
                    }
                    repoLabelMetrics[repoName][labelName] += 1;
                }
            }
        }
        
        // Also process current labels on the issue
        if (issue.labels && issue.labels.length > 0) {
            for (const label of issue.labels) {
                const labelName = label.name;
                const category = categorizeLabel(labelName);
                
                if (category === 'bug') {
                    repoLabelMetrics[repoName]['Bug label'] += 1;
                } else if (category === 'enhancement') {
                    repoLabelMetrics[repoName]['Enhancement label'] += 1;
                } else {
                    // This is an "other" label - track it individually
                    allOtherLabels.add(labelName);
                    if (!repoLabelMetrics[repoName][labelName]) {
                        repoLabelMetrics[repoName][labelName] = 0;
                    }
                    repoLabelMetrics[repoName][labelName] += 1;
                }
            }
        }
    }
    
    return {
        repoMetrics: repoLabelMetrics,
        otherLabels: Array.from(allOtherLabels).sort(),
        issuesCreatedByRepo
    };
}

// Function to generate a comprehensive labels report
async function generateLabelsReport(repoOwner: string) {
    console.log("🏷️  Generating comprehensive labels report...");
    const repositories = await fetchRepositories(repoOwner);
    const workbook = xlsx.utils.book_new();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1);

    for (const [weeksAgo, periodName] of Object.entries(PERIODS)) {
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - Number(weeksAgo) * 7);
        
        const { repoMetrics, otherLabels, issuesCreatedByRepo } = await getDetailedLabelMetricsByRepo(repoOwner, repositories, startDate, endDate);
        
        // Create header row: Repo | Issues created | Bug label | Enhancement label | otherLabel1 | otherLabel2 | ...
        const headerRow = [
            "Repo",
            "Issues created", 
            "Bug label", 
            "Enhancement label",
            ...otherLabels
        ];
        
        const sheetData: any[] = [headerRow];
        
        // Create rows for each repository
        Object.keys(repoMetrics).forEach(repoName => {
            const row = [
                repoName,
                issuesCreatedByRepo[repoName] || 0,
                repoMetrics[repoName]['Bug label'] || 0,
                repoMetrics[repoName]['Enhancement label'] || 0
            ];
            
            // Add counts for each "other" label
            otherLabels.forEach(labelName => {
                row.push(repoMetrics[repoName][labelName] || 0);
            });
            
            sheetData.push(row);
        });

        const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
        
        // Set column widths
        const columnWidths = [
            {wch: 25}, // Repo
            {wch: 15}, // Issues created
            {wch: 12}, // Bug label
            {wch: 18}, // Enhancement label
        ];
        
        // Add widths for other label columns
        otherLabels.forEach(() => {
            columnWidths.push({wch: 15});
        });
        
        worksheet['!cols'] = columnWidths;
        
        xlsx.utils.book_append_sheet(workbook, worksheet, periodName);
    }

    // Save the labels report
    xlsx.writeFile(workbook, LABELS_FILE_PATH, {bookType: "xlsx"});
    console.log(`Labels report saved to ${LABELS_FILE_PATH}`);
    
    return LABELS_FILE_PATH;
}


// Preload cache for better performance
async function preloadCacheForDateRange(
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<void> {
    console.log("🚀 Preloading cache for better performance...");
    
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    
    // Preload commits cache
    for (const {since, until} of dateIntervals) {
        for (const repo of repositories) {
            const cacheKey = `${repoOwner}-${repo}-${since}-${until}`;
            await ISSUES_CACHE.preloadKey(cacheKey);
        }
    }
    
    // Preload pull requests cache
    for (const {since, until} of dateIntervals) {
        const cacheKey = `${repoOwner}-${since}-${until}`;
        await PRS_CACHE.preloadKey(cacheKey);
    }
    
    console.log("✅ Cache preloading completed");
}

// Function to generate reports for multiple time PERIODS
export async function generateReport(
    repoOwner: string,
) {
    try {
        const repositories = await fetchRepositories(repoOwner);
        
        // Cleanup expired cache entries
        await cleanupAllCaches();
        
        const workbook = xlsx.utils.book_new();
        const endDate = new Date();
        // We need to start from yesterday
        endDate.setDate(endDate.getDate() - 1);
        let rankedUsers: RankedUser[] = [];
        
        // Preload cache for the longest period (12 weeks) to cover all cases
        const longestStartDate = new Date();
        longestStartDate.setDate(endDate.getDate() - 12 * 7);
        await preloadCacheForDateRange(repoOwner, repositories, longestStartDate, endDate);

        for (const [weeksAgo, periodName] of Object.entries(PERIODS)) {
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - Number(weeksAgo) * 7);
            const report = await aggregateMetricsByDateRange(repoOwner, repositories, startDate, endDate);
            const commitsData = Object.entries(report)
                .map((item: any) => {
                    return {
                        author: String(item[0]).toLowerCase(),
                        commits: item[1].commits,
                    };
                })
                .sort((a, b) => b.commits - a.commits);
            const mergedPrsData = Object.entries(report)
                .map((item: any) => {
                    return {
                        author: String(item[0]).toLowerCase(),
                        pullRequests: item[1].pullRequests,
                    };
                })
                .sort((a, b) => b.pullRequests - a.pullRequests);
            const prsReviewsData = Object.entries(report)
                .map((item: any) => {
                    return {
                        author: String(item[0]).toLowerCase(),
                        score: item[1].score,
                    };
                })
                .sort((a, b) => b.score - a.score);
            const prsRejectionsData = Object.entries(report)
                .map((item: any) => {
                    return {
                        author: String(item[0]).toLowerCase(),
                        rejections: item[1].rejections,
                    };
                })
                .sort((a, b) => b.rejections - a.rejections);

            //Create a function to calculate the aggregate ranking
            const aggregateRanking = (): RankedUser[] => {
                const rankingMap: { [key: string]: number } = {};

                const sumIndexes = (array: any[]) => {
                    array.forEach((item, index) => {
                        const user = item.author;
                        if (!rankingMap[user]) rankingMap[user] = 0;
                        rankingMap[user] += index;
                    });
                };

                sumIndexes(commitsData);
                sumIndexes(mergedPrsData);
                sumIndexes(prsReviewsData);
                sumIndexes(prsRejectionsData);

                return Object.entries(rankingMap)
                    .map(([user, totalIndex]) => ({user, totalIndex}))
                    .sort((a, b) => a.totalIndex - b.totalIndex);
            };

            rankedUsers = aggregateRanking();

            const sheetData: any[] = [];
            sheetData.push([
                "Commit's Users", "Changes: additions + deletions", 
                "Merged PRS", "No of Merged PRS", 
                "PRS Reviews", "No of PRS Reviews",
                "Prs Rejected", "Nr of Prs Rejected"
            ]);
            
            const maxRows = Math.max(commitsData.length, mergedPrsData.length, prsReviewsData.length, prsRejectionsData.length);
            for(let i = 0; i < maxRows; i++) {
                sheetData.push([
                    i < commitsData.length ? `${i + 1}.  ${commitsData[i].author}` : "",
                    i < commitsData.length ? `${commitsData[i].commits}` : "",
                    i < mergedPrsData.length ? `${i + 1}.  ${mergedPrsData[i].author}` : "",
                    i < mergedPrsData.length ? `${mergedPrsData[i].pullRequests}` : "",
                    i < prsReviewsData.length ? `${i + 1}.  ${prsReviewsData[i].author}` : "",
                    i < prsReviewsData.length ? `${parseFloat(prsReviewsData[i].score.toFixed(1))}` : "",
                    i < prsRejectionsData.length ? `${i + 1}.  ${prsRejectionsData[i].author}` : "",
                    i < prsRejectionsData.length ? `${prsRejectionsData[i].rejections}` : "",
                ]);
            }

            const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
            worksheet['!cols'] = [
                {wch: 20}, // Commit's Users
                {wch: 10}, // Changes: additions + deletions  
                {wch: 20}, // Merged PRS
                {wch: 12}, // No of Merged PRS
                {wch: 20}, // PRS Reviews
                {wch: 12}, // No of PRS Reviews
                {wch: 20}, // Prs Rejected
                {wch: 15}, // Nr of Prs Rejected
            ];
            xlsx.utils.book_append_sheet(workbook, worksheet, periodName);
        }

        // Generate the labels report
        console.log("🏷️  Starting labels report generation...");
        const labelsReportPath = await generateLabelsReport(repoOwner);
        console.log("✅ Labels report generation completed!");
        
        // Send the reports via email
        const attachment = xlsx.writeFile(workbook, FILE_PATH, {bookType: "xlsx"});
        await sendEmailWithAttachments(attachment, rankedUsers, labelsReportPath);
        
    } catch (error) {
        console.error("❌ Error generating report:", error);
        throw error;
    } finally {
        // Close all cache connections gracefully
        await closeAllCaches();
    }
}







