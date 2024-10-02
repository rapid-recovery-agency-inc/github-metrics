import {Octokit} from "octokit";
import dotenv from "dotenv";
import xlsx from "xlsx";
import fetch from 'node-fetch';
import express, {Request, Response} from "express";
import {getDateIntervals} from "./utils.js";
import {COMMITS_QUERY} from "./graphql-queries.js";
import {
    GraphQLCommit,
    GraphQLCommitResponse,
    GraphQLReview,
    GraphQLReviewNode,
    GraphQLReviewThread,
    GraphQLReviewThreadNode,
    RestIssueAndPullRequest,
    ReviewsForPullRequest
} from "./types";
import {sendTemplateEmail} from "./email.js";
import {COMMITS_CACHE, PRS_CACHE, PRS_REVIEW_CACHE} from "./cache.js";
import morgan from "morgan";


const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

dotenv.config();

interface RankedUser {
    user: string;
    totalIndex: number;
}

const FILE_PATH = "GitHub_Metrics_Report.xlsx";
// Initialize Octokit instance with GitHub token
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

// The periods to generate reports for
const periods: Record<number, string> = {
    2: "Last 2 Weeks",
    4: "Last 4 Weeks",
    6: "Last 6 Weeks",
    12: "Last 12 Weeks",
};

const repoOwner = `${process.env.GITHUB_ORG}`;


const MAX_RETRIES = 3;
const BLACKLISTED_CODE_USERS = new Set<string>(["Waqas", "Fullstack900", "ghost", "dependabot[bot]", "Unknown", "nicolas-toledo", "anjelysleal", "juansebasmarin", "YamilaChan", "kaikrmen", "MetalMagno", "aovallegalan", "shedeed1", "YamilaChan"]);
const AUTHOR_ALIAS_MAP = new Map<string, string>([
    ["Yeferson Hidalgo", "MemiMint"]
]);

// Helper function to handle rate limits and retry after the reset time
async function handleRateLimit(response: any) {
    if (response.headers["x-ratelimit-remaining"] === "0") {
        const resetTimestamp =
            parseInt(response.headers["x-ratelimit-reset"], 10) * 1000; // Convert to milliseconds
        const resetTime = new Date(resetTimestamp);
        const currentTime = new Date();

        const waitTime = resetTime.getTime() - currentTime.getTime();

        // Wait until the rate limit resets
        await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
}

// Function to fetch all commits within a given date range using date intervals

async function fetchCommitsInDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
) {
    console.log("DEBUG:fetchCommitsInDateRange:", repoOwner, startDate, endDate);
    const allCommits: GraphQLCommit[] = [];
    const dateIntervals = getDateIntervals(startDate, endDate);
    for (const {since, until} of dateIntervals) {
        const cacheKey = `${repoOwner}-${since}-${until}`;
        const cachedResult = COMMITS_CACHE.get<GraphQLCommit[]>(cacheKey);
        if (cachedResult) {
            allCommits.push(...cachedResult);
            continue;
        }
        let cursor: string | null = null;
        let hasMore = true;
        while (hasMore) {
            const variables = {repoOwner, since, until, cursor};
            let retries = MAX_RETRIES;
            let success = false;
            while (retries > 0 && !success) {
                try {
                    const response = await fetch(GITHUB_GRAPHQL_API, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                        },
                        body: JSON.stringify({
                            query: COMMITS_QUERY,
                            variables,
                        }),
                    });
                    // Check rate limit headers
                    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
                    const rateLimitReset = response.headers.get("x-ratelimit-reset");
                    if (rateLimitRemaining === "0" && rateLimitReset) {
                        const resetTime = parseInt(rateLimitReset, 10) * 1000;
                        const currentTime = Date.now();
                        const waitTime = resetTime - currentTime;
                        if (waitTime > 0) {
                            await new Promise((resolve) => setTimeout(resolve, waitTime));
                        }
                    }
                    const result: GraphQLCommitResponse = (await response.json()) as GraphQLCommitResponse;
                    if (result.errors) {
                        console.error("GraphQL errors:fetchCommitsInDateRange:", result.errors);
                        throw new Error("GraphQL query failed");
                    }
                    const repositories = result.data.repositoryOwner.repositories.edges;
                    for (const repo of repositories) {
                        const history = repo.node.defaultBranchRef.target.history;
                        const commits = history.edges.map((edge: any) => edge.node);
                        if (commits.length > 0) {
                            allCommits.push(...commits);
                            COMMITS_CACHE.set(cacheKey, commits);
                        }
                        hasMore = history.pageInfo.hasNextPage;
                        cursor = history.pageInfo.endCursor;
                    }
                    success = true;
                    if (!hasMore) break;
                } catch (error: any) {
                    if (retries === 0) {
                        throw new Error("Failed after multiple retries");
                    }
                    const retryWaitTime = (MAX_RETRIES - retries) * 1000;
                    await new Promise((resolve) => setTimeout(resolve, retryWaitTime));
                }
            }
        }
    }
    return allCommits;
}

// Function to fetch all pull requests within a given date range using date intervals
async function fetchPullRequestsInDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
) {
    console.log("DEBUG:fetchPullRequestsInDateRange:", repoOwner, startDate, endDate);
    const allPullRequests: RestIssueAndPullRequest[] = [];
    const dateIntervals = getDateIntervals(startDate, endDate, 5);
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
    console.log("DEBUG:fetchReviewsForPR:", repoOwner, repoName, prNumber);
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

// Function to aggregate metrics for a specific date range
async function aggregateMetricsByDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
) {
    const userMetrics: any = {};
    const commits = await fetchCommitsInDateRange(repoOwner, startDate, endDate);
    const pullRequests = await fetchPullRequestsInDateRange(
        repoOwner,
        startDate,
        endDate
    );
    commits.forEach((commit) => {
        if (!commit) {
            return;
        }
        let author = "Unknown";
        if (commit.authors?.nodes && commit.authors.nodes.length > 0) {
            if (commit.authors.nodes[0].user && commit.authors.nodes[0].user.login)
                author = commit.authors.nodes[0].user.login;
        }
        if (author === "Unknown" && commit.author) {
            author = commit.author.name ?? "Unknown";
        }
        if (AUTHOR_ALIAS_MAP.has(author)) {
            author = AUTHOR_ALIAS_MAP.get(author) || author;
        }
        if (BLACKLISTED_CODE_USERS.has(author)) {
            return;
        }
        userMetrics[author] = userMetrics[author] || {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            score: 0,
        };
        const additions = commit.additions || 0;
        const deletions = commit.deletions || 0;
        userMetrics[author].commits += additions + deletions;

    });

    for (const pr of pullRequests) {
        const author = pr.user?.login || "Unknown";
        if (BLACKLISTED_CODE_USERS.has(author)) {
            continue;
        }
        const repoName = `${pr.repository_url.split("/").pop()}`;
        userMetrics[author] = userMetrics[author] || {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            score: 0,
        };
        // Increment the number of PRs raised
        userMetrics[author].pullRequests += 1;
        // Fetch reviews for the current PR
        const {reviews, reviewThreads} = await fetchReviewsForPR(repoOwner, repoName, pr.number);
        reviews.forEach((review) => {
            const reviewer = review.author?.login || "Unknown";
            userMetrics[reviewer] = userMetrics[reviewer] || {
                commits: 0,
                pullRequests: 0,
                reviews: 0,
                score: 0,
            };
            // Increment the number of reviews by the user
            userMetrics[reviewer].reviews += 1;

            // Add 1 point for the review
            userMetrics[reviewer].score += 1;

            reviewThreads.forEach((reviewThread) => {
                const threadAuthor = reviewThread?.comments?.edges[0]?.node?.author?.login ?? 'Unknown';
                userMetrics[threadAuthor] = userMetrics[threadAuthor] || {
                    commits: 0,
                    pullRequests: 0,
                    reviews: 0,
                    score: 0,
                };
                userMetrics[threadAuthor].score += 0.1;
            })
        });
    }
    return userMetrics;
}

// Function to generate reports for multiple time periods
async function generateReport(
    repoOwner: string,
    periods: Record<number, string>
) {
    const workbook = xlsx.utils.book_new();
    const endDate = new Date();
    let rankedUsers: RankedUser[] = [];

    for (const [weeksAgo, periodName] of Object.entries(periods)) {
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - Number(weeksAgo) * 7);
        const report = await aggregateMetricsByDateRange(repoOwner, startDate, endDate);
        const commitsData = Object.entries(report)
            .map((item: any) => {
                return {
                    author: item[0],
                    commits: item[1].commits,
                };
            })
            .sort((a, b) => b.commits - a.commits);
        const mergedPrsData = Object.entries(report)
            .map((item: any) => {
                return {
                    author: item[0],
                    pullRequests: item[1].pullRequests,
                };
            })
            .sort((a, b) => b.pullRequests - a.pullRequests);
        const prsReviewsData = Object.entries(report)
            .map((item: any) => {
                return {
                    author: item[0],
                    score: item[1].score,
                };
            })
            .sort((a, b) => b.score - a.score);

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

            return Object.entries(rankingMap)
                .map(([user, totalIndex]) => ({user, totalIndex}))
                .sort((a, b) => a.totalIndex - b.totalIndex);
        };

        rankedUsers = aggregateRanking();

        const sheetData: any[] = [];
        sheetData.push(["Commit's Users", "Changes: additions + deletions", "Merged PRS", "No of Merged PRS", "PRS Reviews", "No of PRS Reviews"]);
        Object.entries(report).forEach(([user, data]: [string, any], index) => {
            sheetData.push([
                `${index + 1}.  ${commitsData[index].author}`,
                `${commitsData[index].commits}`,
                `${index + 1}.  ${mergedPrsData[index].author}`,
                `${mergedPrsData[index].pullRequests}`,
                `${index + 1}.  ${prsReviewsData[index].author}`,
                `${parseFloat(prsReviewsData[index].score.toFixed(1))}`

            ]);
        });
        const worksheet = xlsx.utils.aoa_to_sheet(sheetData);
        worksheet['!cols'] = [
            {wch: 20},
            {wch: 10},
            {wch: 20},
            {wch: 12},
            {wch: 20},
            {wch: 12},
        ];
        xlsx.utils.book_append_sheet(workbook, worksheet, periodName);
    }

    // Send the report via email
    const attachment = xlsx.writeFile(workbook, FILE_PATH, {bookType: "xlsx"});
    await sendEmailWithAttachment(attachment, rankedUsers);
}

// Function to send an email with the report attached
async function sendEmailWithAttachment(attachment: Buffer, aggregateRanking: RankedUser[]) {
    const rankedListString = aggregateRanking.map((rank, index) => {
        return `${index + 1}.  ${rank.user} <br/>`;
    }).join('\n');
    await sendTemplateEmail({
        users: [
            {email: 'alacret@insightt.io'},
            {email: 'ysouki@insightt.io'},
            {email: 'jziebro@insightt.io'},
            {email: 'bhamilton@insightt.io'},
            {email: 'aovalle@insightt.io'},
            {email: 'lpena@insightt.io'}
        ],
        subject: "GitHub Metrics Report",
        body: `${rankedListString}`,
        attachments: [
            {
                filename: FILE_PATH,
                path: FILE_PATH,
            }
        ]

    });
    console.log(`Email sent:`);
}


if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_ORG) {
    console.error("Please set GITHUB_TOKEN and GITHUB_ORG in .env file");
    process.exit(1);
}


const app = express()
const port = process.env.PORT ?? 3000;

app.use(morgan('dev'));

app.get('/github-metric-report', async (req: Request, res: Response) => {
    console.log("Generating GitHub metrics report...");
    await generateReport(repoOwner, periods);
    res.send('Hello World!')
})

// Catch-all route
app.get('*', (req: Request, res: Response) => {
    console.log("404 Not Found:", req.url);
    res.status(404).send('Not Found'); // Or render a 404 page
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

