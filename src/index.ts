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
    ClosedIssue,
    IssueComment,
    IssueParticipation,
    RankedUser,
    ClosedIssueRankedUser,
    IssueEvent,
    LabelMetrics,
    ReviewsForPullRequest
} from "./types";
import {sendTemplateEmail} from "./email.js";
import {PRS_CACHE, PRS_REVIEW_CACHE, ISSUES_CACHE, ISSUE_EVENTS_CACHE, cleanupAllCaches, closeAllCaches} from "./cache.js";
import {AUTHOR_ALIAS_MAP, BLACKLISTED_CODE_USERS, DAYS_IN_INTERVAL, GITHUB_GRAPHQL_API, EXCLUDED_FROM_RANKINGS, EXCLUDED_FROM_CLOSED_ISSUES, EXCLUDED_FROM_DEV_RANKING, isQAUser, CACHE_TTL_SECONDS, CACHE_TTL_HOURS, USE_OFFLINE_MODE, FORCE_REFRESH_MODE, SKIP_COMMITS, CACHE_CONFIG, EXPECTED_QA_USERS, EXPECTED_DEV_USERS} from "./constants";
import {aggregateCommits, fetchCommitsInDateRange} from "./commits";
import {debugToFile} from "./debug";
import {fetchRepositories} from "./repositories";


dotenv.config();



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

// Global statistics for error handling
let errorStats = {
    skippedPRs: 0,
    cachedFallbackPRs: 0,
    resetStats: () => {
        errorStats.skippedPRs = 0;
        errorStats.cachedFallbackPRs = 0;
    }
};

// Function to determine appropriate TTL based on data age (PERPETUAL CACHE STRATEGY)
function getSmartCacheTTL(dateRange: {since: string, until: string}, dataType: 'prs' | 'issues' | 'reviews' | 'events' = 'prs'): number {
    const untilDate = new Date(dateRange.until);
    const now = new Date();
    const daysAgo = Math.floor((now.getTime() - untilDate.getTime()) / (1000 * 60 * 60 * 24));
    
    // Reviews and events NEVER expire - they're immutable once created
    if (dataType === 'reviews' || dataType === 'events') {
        console.log(`🔒 ${dataType} data - PERPETUAL cache (never expires)`);
        return CACHE_CONFIG.REVIEWS_TTL_SECONDS; // 0 = never expire
    }
    
    // Historical data (older than 7 days) - NEVER expires once cached
    if (daysAgo > 7) {
        console.log(`📚 Historical data (${daysAgo} days old) - PERPETUAL cache (never expires)`);
        return CACHE_CONFIG.HISTORICAL_TTL_SECONDS; // 0 = never expire
    }
    
    // Recent data (last 7 days) - short TTL for potential updates
    if (daysAgo > 0) {
        console.log(`📈 Recent data (${daysAgo} days old) - short cache (${CACHE_CONFIG.RECENT_TTL_HOURS}h)`);
        return CACHE_CONFIG.RECENT_TTL_SECONDS;
    }
    
    // Today's data - shortest TTL for real-time accuracy
    console.log(`🔄 Today's data - short cache (${CACHE_CONFIG.TODAY_TTL_HOURS}h)`);
    return CACHE_CONFIG.TODAY_TTL_SECONDS;
}

// Function to check API rate limit
async function checkRateLimit(): Promise<{canMakeRequest: boolean, resetTime?: Date}> {
    try {
        const response = await octokit.rest.rateLimit.get();
        const searchLimit = response.data.resources.search;
        
        console.log(`🔍 API Rate Limit Status - Search: ${searchLimit.remaining}/${searchLimit.limit} (resets at ${new Date(searchLimit.reset * 1000)})`);
        
        if (searchLimit.remaining <= 5) { // Keep some buffer
            return {
                canMakeRequest: false,
                resetTime: new Date(searchLimit.reset * 1000)
            };
        }
        
        return { canMakeRequest: true };
    } catch (error) {
        console.warn("⚠️ Could not check rate limit, proceeding with caution:", error);
        return { canMakeRequest: true };
    }
}

// Function to wait for rate limit reset
async function waitForRateLimit(resetTime: Date): Promise<void> {
    const now = new Date();
    const waitTime = resetTime.getTime() - now.getTime();
    
    if (waitTime > 0) {
        console.log(`⏳ Waiting ${Math.ceil(waitTime / 1000 / 60)} minutes for rate limit reset...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
}


// Function to fetch all pull requests within a given date range using date intervals
async function fetchPullRequestsInDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
) {
    const allPullRequests: RestIssueAndPullRequest[] = [];
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    
    for (const {since, until} of dateIntervals) {
        const cacheKey = `${repoOwner}-prs-${since}-${until}`;
        
        // Try to get from cache first (unless force refresh mode is enabled)
        let cachedResult = FORCE_REFRESH_MODE ? null : await PRS_CACHE.getAsync<RestIssueAndPullRequest[]>(cacheKey);
        if (cachedResult && cachedResult.length > 0 && !FORCE_REFRESH_MODE) {
            console.log(`📦 Using cached PRs for ${since}..${until} (${cachedResult.length} items)`);
            allPullRequests.push(...cachedResult);
            continue;
        }
        
        if (FORCE_REFRESH_MODE) {
            console.log(`🔄 Force refresh mode - fetching fresh data for ${since}..${until}`);
        }
        
        // If in offline mode and no cache, skip this interval
        if (USE_OFFLINE_MODE) {
            console.log(`⚠️ Offline mode: skipping PRs for ${since}..${until} (no cache available)`);
            continue;
        }
        
        // Check rate limit before making API calls
        const rateLimitStatus = await checkRateLimit();
        if (!rateLimitStatus.canMakeRequest) {
            if (rateLimitStatus.resetTime) {
                await waitForRateLimit(rateLimitStatus.resetTime);
            } else {
                console.log(`⚠️ Rate limit exceeded, skipping PRs for ${since}..${until}`);
                continue;
            }
        }
        
        let page = 1;
        let hasMore = true;
        const intervalPRs: RestIssueAndPullRequest[] = [];
        
        while (hasMore) {
            try {
                console.log(`🔍 Fetching PRs for ${since}..${until}, page ${page}`);
                const response = await octokit.rest.search.issuesAndPullRequests({
                    q: `org:${repoOwner} type:pr is:merged created:${since}..${until}`,
                    per_page: 100,
                    page,
                });
                
                // Handle rate limiting
                await handleRateLimit(response);
                intervalPRs.push(...response.data.items);

                // Check if there are more pages
                hasMore = response.data.items.length === 100;
                page += 1;
            } catch (error: any) {
                if (error.status === 403) {
                    console.log("⚠️ Rate limit hit during PR fetch, waiting...");
                    await handleRateLimit(error.response);
                } else {
                    console.error(`Error fetching PRs for ${since}..${until}:`, error);
                    break;
                }
            }
        }
        
        // Cache the results with smart TTL (perpetual for historical data)
        if (intervalPRs.length > 0) {
            const smartTTL = getSmartCacheTTL({since, until}, 'prs');
            await PRS_CACHE.setAsync(cacheKey, intervalPRs, smartTTL);
            const ttlDesc = smartTTL === 0 ? 'PERPETUAL' : `${smartTTL/3600}h`;
            console.log(`💾 Cached ${intervalPRs.length} PRs for ${since}..${until} (TTL: ${ttlDesc})`);
        }
        
        allPullRequests.push(...intervalPRs);
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
    
    // In offline mode, return empty data if not cached
    if (USE_OFFLINE_MODE) {
        console.log(`⚠️ Offline mode: skipping reviews for PR ${prNumber} (no cache available)`);
        return {reviews: allReviews, reviewThreads: allReviewThreads};
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

                if (!response.ok) {
                    if (response.status === 403) {
                        console.log(`⏳ GraphQL rate limit hit, waiting 60 seconds...`);
                        await new Promise(resolve => setTimeout(resolve, 60000));
                        throw new Error("Rate limit - retry");
                    }
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const result: any = await response.json();

                if (result.errors) {
                    console.error(`❌ GraphQL errors for PR ${prNumber}:`, result.errors);
                    // Si es un error de rate limit, esperamos y reintentamos
                    if (result.errors.some((err: any) => err.type === 'RATE_LIMITED')) {
                        console.log(`⏳ GraphQL rate limit in response, waiting 60 seconds...`);
                        await new Promise(resolve => setTimeout(resolve, 60000));
                        throw new Error("Rate limit - retry");
                    }
                    throw new Error(`GraphQL query failed: ${result.errors[0]?.message || 'Unknown error'}`);
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
                console.log(`⚠️ Error fetching reviews for PR ${prNumber} (${retries} retries left): ${error.message}`);

                if (retries === 0) {
                    console.error(`❌ Failed to fetch reviews for PR ${prNumber} after ${MAX_RETRIES} retries`);
                    
                    // Try to use cached data as fallback
                    const cachedFallback = PRS_REVIEW_CACHE.get<ReviewsForPullRequest>(cacheKey);
                    if (cachedFallback) {
                        console.log(`🔄 Using cached data as fallback for PR ${prNumber}`);
                        errorStats.cachedFallbackPRs++;
                        return {...cachedFallback};
                    }
                    
                    console.log(`⚠️ No cached data available, skipping PR ${prNumber} and continuing...`);
                    errorStats.skippedPRs++;
                    // Return empty result instead of throwing error
                    return {
                        reviews: [],
                        reviewThreads: []
                    };
                }

                const retryWaitTime = (MAX_RETRIES - retries) * 1000;
                console.log(`⏳ Waiting ${retryWaitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryWaitTime));
            }
        }
    }

    // Use longer TTL for reviews as they rarely change
    const reviewData = {reviews: allReviews, reviewThreads: allReviewThreads};
    await PRS_REVIEW_CACHE.setAsync(cacheKey, reviewData, CACHE_CONFIG.REVIEWS_TTL_SECONDS);
    return reviewData;
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
        
        // Try to get from cache first (unless force refresh mode is enabled)
        let cachedResult = FORCE_REFRESH_MODE ? null : await ISSUES_CACHE.getAsync<RestIssue[]>(cacheKey);
        if (cachedResult && cachedResult.length > 0 && !FORCE_REFRESH_MODE) {
            console.log(`📦 Using cached issues for ${since}..${until} (${cachedResult.length} items)`);
            allIssues.push(...cachedResult);
            continue;
        }
        
        if (FORCE_REFRESH_MODE) {
            console.log(`🔄 Force refresh mode - fetching fresh issues for ${since}..${until}`);
        }
        
        // If in offline mode and no cache, skip this interval
        if (USE_OFFLINE_MODE) {
            console.log(`⚠️ Offline mode: skipping issues for ${since}..${until} (no cache available)`);
            continue;
        }
        
        // Check rate limit before making API calls
        const rateLimitStatus = await checkRateLimit();
        if (!rateLimitStatus.canMakeRequest) {
            if (rateLimitStatus.resetTime) {
                await waitForRateLimit(rateLimitStatus.resetTime);
            } else {
                console.log(`⚠️ Rate limit exceeded, skipping issues for ${since}..${until}`);
                continue;
            }
        }
        
        let page = 1;
        let hasMore = true;
        const intervalIssues: RestIssue[] = [];
        
        while (hasMore) {
            try {
                console.log(`🔍 Fetching issues for ${since}..${until}, page ${page}`);
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
                    console.log("⚠️ Rate limit hit during issues fetch, waiting...");
                    await handleRateLimit(error.response);
                } else {
                    console.error(`Error fetching issues for ${since}..${until}:`, error);
                    break;
                }
            }
        }
        
        // Cache the results with smart TTL (perpetual for historical data)
        if (intervalIssues.length > 0) {
            const smartTTL = getSmartCacheTTL({since, until}, 'issues');
            await ISSUES_CACHE.setAsync(cacheKey, intervalIssues, smartTTL);
            const ttlDesc = smartTTL === 0 ? 'PERPETUAL' : `${smartTTL/3600}h`;
            console.log(`💾 Cached ${intervalIssues.length} issues for ${since}..${until} (TTL: ${ttlDesc})`);
        }
        
        allIssues.push(...intervalIssues);
    }
    
    return allIssues;
}

// Function to fetch closed issues within a given date range
async function fetchClosedIssuesInDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
): Promise<ClosedIssue[]> {
    const allClosedIssues: ClosedIssue[] = [];
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    
    for (const {since, until} of dateIntervals) {
        const cacheKey = `${repoOwner}-closed-issues-${since}-${until}`;
        
        // Try to get from cache first (unless force refresh mode is enabled)
        let cachedResult = FORCE_REFRESH_MODE ? null : await ISSUES_CACHE.getAsync<ClosedIssue[]>(cacheKey);
        if (cachedResult && cachedResult.length > 0 && !FORCE_REFRESH_MODE) {
            console.log(`📦 Using cached closed issues for ${since}..${until} (${cachedResult.length} items)`);
            allClosedIssues.push(...cachedResult);
            continue;
        }
        
        if (FORCE_REFRESH_MODE) {
            console.log(`🔄 Force refresh mode - fetching fresh closed issues for ${since}..${until}`);
        }
        
        // If in offline mode and no cache, skip this interval
        if (USE_OFFLINE_MODE) {
            console.log(`⚠️ Offline mode: skipping closed issues for ${since}..${until} (no cache available)`);
            continue;
        }
        
        // Check rate limit before making API calls
        const rateLimitStatus = await checkRateLimit();
        if (!rateLimitStatus.canMakeRequest) {
            if (rateLimitStatus.resetTime) {
                await waitForRateLimit(rateLimitStatus.resetTime);
            } else {
                console.log(`⚠️ Rate limit exceeded, skipping closed issues for ${since}..${until}`);
                continue;
            }
        }
        
        let page = 1;
        let hasMore = true;
        const intervalIssues: ClosedIssue[] = [];
        
        while (hasMore) {
            try {
                console.log(`🔍 Fetching closed issues for ${since}..${until}, page ${page}`);
                // Search for closed issues within the date range
                const response = await octokit.rest.search.issuesAndPullRequests({
                    q: `org:${repoOwner} type:issue is:closed closed:${since}..${until}`,
                    per_page: 100,
                    page,
                });
                
                await handleRateLimit(response);
                const closedIssues = response.data.items
                    .filter((item: any) => !item.pull_request && item.state === 'closed') 
                    .map((issue: any) => ({
                        ...issue,
                        state: 'closed' as const,
                        assignees: issue.assignees || [],
                        assignee: issue.assignee || null
                    })) as ClosedIssue[];
                    
                intervalIssues.push(...closedIssues);
                
                hasMore = response.data.items.length === 100;
                page += 1;
            } catch (error: any) {
                if (error.status === 403) {
                    console.log("⚠️ Rate limit hit during closed issues fetch, waiting...");
                    await handleRateLimit(error.response);
                } else {
                    console.error(`Error fetching closed issues for ${since}..${until}:`, error);
                    break;
                }
            }
        }
        
        // Cache the results with smart TTL (perpetual for historical data)
        if (intervalIssues.length > 0) {
            const smartTTL = getSmartCacheTTL({since, until}, 'issues');
            await ISSUES_CACHE.setAsync(cacheKey, intervalIssues, smartTTL);
            const ttlDesc = smartTTL === 0 ? 'PERPETUAL' : `${smartTTL/3600}h`;
            console.log(`💾 Cached ${intervalIssues.length} closed issues for ${since}..${until} (TTL: ${ttlDesc})`);
        }
        
        allClosedIssues.push(...intervalIssues);
    }
    
    return allClosedIssues;
}

// Function to fetch comments for an issue
async function fetchIssueComments(
    repoOwner: string,
    repoName: string,
    issueNumber: number
): Promise<IssueComment[]> {
    try {
        const response = await octokit.rest.issues.listComments({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
            per_page: 100,
        });
        
        await handleRateLimit(response);
        
        return response.data.map((comment: any) => ({
            user: {
                login: comment.user.login
            },
            created_at: comment.created_at,
            body: comment.body
        }));
    } catch (error: any) {
        if (error.status === 404) {
            console.log(`⚠️ Issue #${issueNumber} not found or no access - skipping comments`);
        } else {
            console.error(`Error fetching comments for issue ${issueNumber}:`, error.message || error);
        }
        return [];
    }
}

// Function to check if an issue is mentioned in any PRs
async function findPRsMentioningIssue(
    repoOwner: string,
    issueNumber: number,
    startDate: Date,
    endDate: Date
): Promise<string[]> {
    try {
        // Search for PRs that mention this issue number
        const response = await octokit.rest.search.issuesAndPullRequests({
            q: `org:${repoOwner} type:pr ${issueNumber} created:${startDate.toISOString().split('T')[0]}..${endDate.toISOString().split('T')[0]}`,
            per_page: 100,
        });
        
        await handleRateLimit(response);
        
        const mentioningUsers: string[] = [];
        
        for (const pr of response.data.items) {
            if (pr.pull_request && (pr.body?.includes(`#${issueNumber}`) || pr.title.includes(`#${issueNumber}`))) {
                mentioningUsers.push(pr.user.login);
            }
        }
        
        return [...new Set(mentioningUsers)]; // Remove duplicates
    } catch (error: any) {
        if (error.status === 403) {
            console.log(`⚠️ Rate limit hit while searching PRs mentioning issue ${issueNumber} - skipping`);
        } else {
            console.error(`Error searching PRs mentioning issue ${issueNumber}:`, error.message || error);
        }
        return [];
    }
}

// Function to aggregate participation data for closed issues
async function aggregateClosedIssueParticipation(
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<Record<string, number>> {
    const participation: Record<string, number> = {};
    
    console.log("🔍 Fetching closed issues participation data...");
    
    // Fetch all closed issues in the date range
    const closedIssues = await fetchClosedIssuesInDateRange(repoOwner, startDate, endDate);
    
    console.log(`📊 Found ${closedIssues.length} closed issues to analyze`);
    
    for (const issue of closedIssues) {
        const repoName = issue.repository_url.split('/').pop() || '';
        const participants = new Set<string>();
        
        // Add assignees
        if (issue.assignee) {
            participants.add(issue.assignee.login);
        }
        if (issue.assignees) {
            issue.assignees.forEach(assignee => participants.add(assignee.login));
        }
        
        // Add commenters
        try {
            const comments = await fetchIssueComments(repoOwner, repoName, issue.number);
            comments.forEach(comment => participants.add(comment.user.login));
        } catch (error) {
            console.error(`Error fetching comments for issue ${issue.number}:`, error);
        }
        
        // Add PR mentioners
        try {
            const prMentioners = await findPRsMentioningIssue(repoOwner, issue.number, startDate, endDate);
            prMentioners.forEach(user => participants.add(user));
        } catch (error) {
            console.error(`Error finding PR mentions for issue ${issue.number}:`, error);
        }
        
        // Count participation for each user
        participants.forEach(user => {
            const normalizedUser = user.toLowerCase();
            // Skip excluded users from general rankings
            if (EXCLUDED_FROM_RANKINGS.has(normalizedUser)) {
                console.log(`🚫 Excluding user from closed issues: ${normalizedUser}`);
                return;
            }
            // Skip excluded users from closed issues rankings
            if (EXCLUDED_FROM_CLOSED_ISSUES.has(normalizedUser)) {
                return;
            }
            
            // Apply alias mapping
            const aliasUser = AUTHOR_ALIAS_MAP.get(normalizedUser);
            const realUser = aliasUser ?? normalizedUser;
            
            participation[realUser] = (participation[realUser] || 0) + 1;
        });
    }
    
    console.log(`✅ Participation data aggregated for ${Object.keys(participation).length} users`);
    return participation;
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
        // Issue events rarely change, use longer TTL
        await ISSUE_EVENTS_CACHE.setAsync(cacheKey, labelEvents, CACHE_CONFIG.REVIEWS_TTL_SECONDS);
        
        return labelEvents.filter(event => {
            const eventDate = new Date(event.created_at);
            return eventDate >= startDate && eventDate <= endDate;
        });
    } catch (error: any) {
        if (error.status === 404) {
            console.log(`⚠️ Issue #${issueNumber} not found or no access (repo: ${repoName}) - skipping label events`);
        } else {
            console.error(`Error fetching label events for issue ${issueNumber}:`, error.message || error);
        }
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
    
    // Skip commits in offline mode to avoid network issues
    let commits: any[] = [];
    if (!SKIP_COMMITS) {
        commits = await fetchCommitsInDateRange(repoOwner, repositories, startDate, endDate);
    } else {
        console.log('⚠️ Skipping commits data (offline mode)');
    }
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
                rawUserMetrics[author].rejections += 1;
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
        if (EXCLUDED_FROM_RANKINGS.has(normalizedAuthor)) { // Exclude users from rankings (system accounts, etc.)
            console.log(`🚫 Excluding user from rankings: ${normalizedAuthor}`);
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

// Function to ensure all expected users appear in metrics, even with 0 values
function ensureAllExpectedUsers(
    metrics: Record<string, AggregateMetrics>, 
    closedIssuesParticipation: Record<string, number>
): { 
    metrics: Record<string, AggregateMetrics>, 
    closedIssuesParticipation: Record<string, number> 
} {
    const defaultMetrics: AggregateMetrics = {
        commits: 0,
        pullRequests: 0,
        reviews: 0,
        rejections: 0,
        score: 0,
        bugLabels: 0,
        enhancementLabels: 0,
        otherLabels: 0,
    };

    // Ensure all expected QA users are present
    EXPECTED_QA_USERS.forEach(user => {
        if (!metrics[user]) {
            metrics[user] = { ...defaultMetrics };
        }
        if (!(user in closedIssuesParticipation)) {
            closedIssuesParticipation[user] = 0;
        }
    });

    // Ensure all expected Dev users are present
    EXPECTED_DEV_USERS.forEach(user => {
        if (!metrics[user]) {
            metrics[user] = { ...defaultMetrics };
        }
        if (!(user in closedIssuesParticipation)) {
            closedIssuesParticipation[user] = 0;
        }
    });

    return { metrics, closedIssuesParticipation };
}

// Function to send an email with the reports attached
async function sendEmailWithAttachments(
    _unused: any, 
    qaRanking: RankedUser[], 
    devRanking: RankedUser[], 
    closedIssuesQARanking: ClosedIssueRankedUser[],
    closedIssuesDevRanking: ClosedIssueRankedUser[],
    labelsReportPath?: string
) {
    
    const qaRankedListString = qaRanking.map((rank, index) => {
        const position = rank.finalRank || (index + 1);
        return `${position}.  ${rank.user} <br/>`;
    }).join('\n');
    
    const devRankedListString = devRanking.map((rank, index) => {
        const position = rank.finalRank || (index + 1);
        return `${position}.  ${rank.user} <br/>`;
    }).join('\n');
    
    const closedIssuesQARankedListString = closedIssuesQARanking.map((rank, index) => {
        return `${index + 1}.  ${rank.user} (${rank.participation || 0} issues) <br/>`;
    }).join('\n');
    
    const closedIssuesDevRankedListString = closedIssuesDevRanking.map((rank, index) => {
        return `${index + 1}.  ${rank.user} (${rank.participation || 0} issues) <br/>`;
    }).join('\n');
    
    const attachments = [
        {
            filename: FILE_PATH,
            path: `./${FILE_PATH}`,
        }
    ];
    
    // Add labels report if it exists
    if (labelsReportPath) {
        attachments.push({
            filename: LABELS_FILE_PATH,
            path: `./${labelsReportPath}`,
        });
    }
    
    await sendTemplateEmail({
        users: [
            {email: 'ezabala@insightt.io'},
            {email: 'alacret@insightt.io'},
            {email: 'ysouki@insightt.io'},
            {email: 'ezabala@insightt.io'},
            {email: 'lpena@insightt.io'}
        ],
        subject: "GitHub Metrics Report",
        body: `
            <h2>🔍 QA Team Ranking</h2>
            ${qaRankedListString}
            
            <h2>💻 Dev Team Ranking</h2>
            ${devRankedListString}
            
            <h2>🎯 QA Team - Closed Issues Participation</h2>
            ${closedIssuesQARankedListString}
            
            <h2>🎯 Dev Team - Closed Issues Participation</h2>
            ${closedIssuesDevRankedListString}
            
            <br/><br/>
            <strong>Note:</strong> Detailed rankings per team are available in separate Excel sheets. Closed Issues participation tracks assignees, commenters, and PR mentions. Labels report is included as a separate attachment.
        `,
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
): Promise<{prsLoaded: number, issuesLoaded: number, closedIssuesLoaded: number}> {
    console.log("🚀 Preloading cache for better performance...");
    
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    let prsLoaded = 0;
    let issuesLoaded = 0;
    let closedIssuesLoaded = 0;
    
    // Preload pull requests cache
    for (const {since, until} of dateIntervals) {
        const prsCacheKey = `${repoOwner}-prs-${since}-${until}`;
        await PRS_CACHE.preloadKey(prsCacheKey);
        const prsData = PRS_CACHE.get(prsCacheKey);
        if (prsData) {
            prsLoaded += Array.isArray(prsData) ? prsData.length : 0;
        }
    }
    
    // Preload issues cache
    for (const {since, until} of dateIntervals) {
        const issuesCacheKey = `${repoOwner}-issues-${since}-${until}`;
        await ISSUES_CACHE.preloadKey(issuesCacheKey);
        const issuesData = ISSUES_CACHE.get(issuesCacheKey);
        if (issuesData) {
            issuesLoaded += Array.isArray(issuesData) ? issuesData.length : 0;
        }
        
        // Preload closed issues cache
        const closedIssuesCacheKey = `${repoOwner}-closed-issues-${since}-${until}`;
        await ISSUES_CACHE.preloadKey(closedIssuesCacheKey);
        const closedIssuesData = ISSUES_CACHE.get(closedIssuesCacheKey);
        if (closedIssuesData) {
            closedIssuesLoaded += Array.isArray(closedIssuesData) ? closedIssuesData.length : 0;
        }
    }
    
    console.log(`✅ Cache preloading completed - PRs: ${prsLoaded}, Issues: ${issuesLoaded}, Closed Issues: ${closedIssuesLoaded}`);
    
    return {prsLoaded, issuesLoaded, closedIssuesLoaded};
}

// Function to generate reports for multiple time PERIODS
export async function generateReport(
    repoOwner: string,
) {
    try {
        // Reset error statistics for this report generation
        errorStats.resetStats();
        
    const repositories = await fetchRepositories(repoOwner);
        
        // Cleanup expired cache entries
        await cleanupAllCaches();
        
    const workbook = xlsx.utils.book_new();
    const endDate = new Date();
    // We need to start from yesterday
    endDate.setDate(endDate.getDate() - 1);
    let qaRanking: RankedUser[] = [];
    let devRanking: RankedUser[] = [];
    let closedIssuesQARanking: ClosedIssueRankedUser[] = [];
    let closedIssuesDevRanking: ClosedIssueRankedUser[] = [];
    let debugInfo: any = {};
        
        // Preload cache for the longest period (12 weeks) to cover all cases
        const longestStartDate = new Date();
        longestStartDate.setDate(endDate.getDate() - 12 * 7);
        const cacheStats = await preloadCacheForDateRange(repoOwner, repositories, longestStartDate, endDate);
        
        // Show cache statistics
        const totalCachedItems = cacheStats.prsLoaded + cacheStats.issuesLoaded + cacheStats.closedIssuesLoaded;
        console.log(`📊 Cache Statistics: ${totalCachedItems} items loaded from cache`);
        
        if (USE_OFFLINE_MODE) {
            console.log(`🔒 Running in OFFLINE MODE - only cached data will be used`);
        } else if (totalCachedItems > 0) {
            console.log(`⚡ Cache hit! This should significantly reduce API calls`);
        } else {
            console.log(`⚠️ No cached data found - will need to fetch from API`);
        }

    // Use only the longest period (12 weeks) for final rankings instead of incorrectly accumulating all periods
    let finalMetrics: Record<string, AggregateMetrics> = {};

    for (const [weeksAgo, periodName] of Object.entries(PERIODS)) {
        const startDate = new Date();
        startDate.setDate(endDate.getDate() - Number(weeksAgo) * 7);
        const report = await aggregateMetricsByDateRange(repoOwner, repositories, startDate, endDate);
        
        // Generate closed issues participation rankings for this specific period
        console.log(`🔍 Generating closed issues participation for ${periodName}...`);
        let closedIssuesParticipation = await aggregateClosedIssueParticipation(repoOwner, repositories, startDate, endDate);
        
        // Ensure all expected users appear in the data, even with 0 values
        const ensuredData = ensureAllExpectedUsers({ ...report }, { ...closedIssuesParticipation });
        const ensuredReport = ensuredData.metrics;
        closedIssuesParticipation = ensuredData.closedIssuesParticipation;
        
        // Store the longest period (12 weeks) data for final rankings
        if (Number(weeksAgo) === 12) {
            finalMetrics = { ...ensuredReport };
            console.log(`📊 Using 12-week period data for final rankings (${Object.keys(finalMetrics).length} users)`);
        }
        
        // Create separate closed issues rankings for QA and Dev for this period
        const closedIssuesData = Object.entries(closedIssuesParticipation)
            .map(([author, participationCount]) => ({
                author,
                participation: participationCount
            }))
            .sort((a, b) => b.participation - a.participation);
            
        console.log(`📊 ${periodName} - Total closed issues participants: ${closedIssuesData.length}`);
        
        const closedIssuesQAData = closedIssuesData.filter(item => isQAUser(item.author));
        const closedIssuesDevData = closedIssuesData.filter(item => !isQAUser(item.author) && !EXCLUDED_FROM_DEV_RANKING.has(item.author.toLowerCase()));
        
        console.log(`👥 ${periodName} - QA closed issues participants: ${closedIssuesQAData.length}`);
        console.log(`💻 ${periodName} - Dev closed issues participants: ${closedIssuesDevData.length}`);
        
        // Create rankings with totalIndex based on participation ranking position for this period
        const periodClosedIssuesQARanking = closedIssuesQAData.map((item, index) => ({
            user: item.author,
            totalIndex: index,
            participation: item.participation
        }));
        
        const periodClosedIssuesDevRanking = closedIssuesDevData.map((item, index) => ({
            user: item.author,
            totalIndex: index,
            participation: item.participation
        }));
        
        // Store the 12-week period data for final rankings (used in email)
        if (Number(weeksAgo) === 12) {
            closedIssuesQARanking = periodClosedIssuesQARanking;
            closedIssuesDevRanking = periodClosedIssuesDevRanking;
        }
        
        // Generate individual period data for Excel sheets
        const commitsData = Object.entries(ensuredReport)
            .map((item: any) => {
                return {
                    author: String(item[0]).toLowerCase(),
                    commits: item[1].commits,
                };
            })
            .sort((a, b) => b.commits - a.commits);
        const mergedPrsData = Object.entries(ensuredReport)
            .map((item: any) => {
                return {
                    author: String(item[0]).toLowerCase(),
                    pullRequests: item[1].pullRequests,
                };
            })
            .sort((a, b) => b.pullRequests - a.pullRequests);
        const prsReviewsData = Object.entries(ensuredReport)
            .map((item: any) => {
                return {
                    author: String(item[0]).toLowerCase(),
                    score: item[1].score,
                };
            })
            .sort((a, b) => b.score - a.score);
            const prsRejectionsData = Object.entries(ensuredReport)
                .map((item: any) => {
                    return {
                        author: String(item[0]).toLowerCase(),
                        rejections: item[1].rejections,
                    };
                })
                .sort((a, b) => a.rejections - b.rejections); // Ascendente: menos rechazos = mejor posición

        //Create a function to calculate the aggregate ranking
        // Helper function to filter data by user type (for individual period sheets)
        const filterDataByUserType = (data: any[], isQA: boolean) => {
            return data.filter(item => {
                const isUserQA = isQAUser(item.author);
                // If we want QA users, return QA users
                if (isQA) {
                    return isUserQA;
                }
                // If we want Dev users, exclude QA users AND specifically excluded dev users
                else {
                    return !isUserQA && !EXCLUDED_FROM_DEV_RANKING.has(item.author.toLowerCase());
                }
            });
        };
        

        // Create separate datasets for QA and Dev users (for individual period sheets)
        const qaCommitsData = filterDataByUserType(commitsData, true);
        const qaMultipliedPrsData = filterDataByUserType(mergedPrsData, true);
        const qaPrsReviewsData = filterDataByUserType(prsReviewsData, true);
        const qaPrsRejectionsData = filterDataByUserType(prsRejectionsData, true);

        const devCommitsData = filterDataByUserType(commitsData, false);
        const devMergedPrsData = filterDataByUserType(mergedPrsData, false);
        const devPrsReviewsData = filterDataByUserType(prsReviewsData, false);
        const devPrsRejectionsData = filterDataByUserType(prsRejectionsData, false);
        
        

        // Helper function to generate sheet data (keeping original structure, adding closed issues at the end)
        const generateSheetData = (commits: any[], prs: any[], reviews: any[], rejections: any[], closedIssues?: ClosedIssueRankedUser[]) => {
        const sheetData: any[] = [];
        
        // Header row - original columns plus closed issues if provided
        const headers = [
            "Commit's Users", "Changes: additions + deletions", 
            "Merged PRS", "No of Merged PRS", 
            "PRS Reviews", "No of PRS Reviews",
                "Prs Rejected", "Nr of Prs Rejected"
        ];
        
        if (closedIssues && closedIssues.length > 0) {
            headers.push("Closed Issues Participation", "Nr of Closed Issues");
        }
        
        sheetData.push(headers);
        
            const maxRows = Math.max(commits.length, prs.length, reviews.length, rejections.length);
        for(let i = 0; i < maxRows; i++) {
            const row = [
                    i < commits.length ? `${i + 1}.  ${commits[i].author}` : "",
                    i < commits.length ? `${commits[i].commits}` : "",
                    i < prs.length ? `${i + 1}.  ${prs[i].author}` : "",
                    i < prs.length ? `${prs[i].pullRequests}` : "",
                    i < reviews.length ? `${i + 1}.  ${reviews[i].author}` : "",
                    i < reviews.length ? `${parseFloat(reviews[i].score.toFixed(1))}` : "",
                    i < rejections.length ? `${i + 1}.  ${rejections[i].author}` : "",
                    i < rejections.length ? `${rejections[i].rejections}` : "",
            ];
            
            // Add closed issues columns only if data is provided
            if (closedIssues && closedIssues.length > 0) {
                row.push(
                    i < closedIssues.length ? `${i + 1}.  ${closedIssues[i].user}` : "",
                    i < closedIssues.length ? `${closedIssues[i].participation || 0}` : ""
                );
            }
            
            sheetData.push(row);
        }
        
        console.log(`🔍 DEBUG - Generated sheet data: ${sheetData.length} rows (including header)`);
        if (sheetData.length > 1) {
            console.log(`📋 Sample row:`, sheetData[1]);
            }
            
            return sheetData;
        };


        
        // Generate QA team ranking sheet (consolidated with closed issues)
        console.log(`📊 Generating QA sheet with ${periodClosedIssuesQARanking.length} closed issues participants`);
        console.log(`🔍 DEBUG - QA Data Arrays Length:`, {
            commits: qaCommitsData.length,
            prs: qaMultipliedPrsData.length,
            reviews: qaPrsReviewsData.length,
            rejections: qaPrsRejectionsData.length,
            closedIssues: periodClosedIssuesQARanking.length
        });
        const qaSheetData = generateSheetData(qaCommitsData, qaMultipliedPrsData, qaPrsReviewsData, qaPrsRejectionsData, periodClosedIssuesQARanking);
        const qaWorksheet = xlsx.utils.aoa_to_sheet(qaSheetData);
        const qaColumnWidths = [
            {wch: 20}, // Commit's Users
            {wch: 10}, // Changes: additions + deletions  
            {wch: 20}, // Merged PRS
            {wch: 12}, // No of Merged PRS
            {wch: 20}, // PRS Reviews
            {wch: 12}, // No of PRS Reviews
            {wch: 20}, // Prs Rejected
            {wch: 15}, // Nr of Prs Rejected
        ];
        
        // Add closed issues column widths if we have QA closed issues data
        if (periodClosedIssuesQARanking && periodClosedIssuesQARanking.length > 0) {
            qaColumnWidths.push(
                {wch: 25}, // Closed Issues Participation
                {wch: 15}  // Nr of Closed Issues
            );
        }
        
        qaWorksheet['!cols'] = qaColumnWidths;
        xlsx.utils.book_append_sheet(workbook, qaWorksheet, `${periodName} - QA Team`);
        
        // Generate Dev team ranking sheet (consolidated with closed issues)
        console.log(`📊 Generating Dev sheet with ${periodClosedIssuesDevRanking.length} closed issues participants`);
        console.log(`🔍 DEBUG - Dev Data Arrays Length:`, {
            commits: devCommitsData.length,
            prs: devMergedPrsData.length,
            reviews: devPrsReviewsData.length,
            rejections: devPrsRejectionsData.length,
            closedIssues: periodClosedIssuesDevRanking.length
        });
        const devSheetData = generateSheetData(devCommitsData, devMergedPrsData, devPrsReviewsData, devPrsRejectionsData, periodClosedIssuesDevRanking);
        const devWorksheet = xlsx.utils.aoa_to_sheet(devSheetData);
        const devColumnWidths = [
            {wch: 20}, // Commit's Users
            {wch: 10}, // Changes: additions + deletions  
            {wch: 20}, // Merged PRS
            {wch: 12}, // No of Merged PRS
            {wch: 20}, // PRS Reviews
            {wch: 12}, // No of PRS Reviews
            {wch: 20}, // Prs Rejected
            {wch: 15}, // Nr of Prs Rejected
        ];
        
        // Add closed issues column widths if we have Dev closed issues data
        if (periodClosedIssuesDevRanking && periodClosedIssuesDevRanking.length > 0) {
            devColumnWidths.push(
                {wch: 25}, // Closed Issues Participation
                {wch: 15}  // Nr of Closed Issues
            );
        }
        
        devWorksheet['!cols'] = devColumnWidths;
        xlsx.utils.book_append_sheet(workbook, devWorksheet, `${periodName} - Dev Team`);
    }
    
    // After processing all periods, calculate final rankings using 12-week data
    console.log("🏆 Calculating final rankings using 12-week period data...");
    
    // Create final data arrays for ranking calculations
    const finalCommitsData = Object.entries(finalMetrics)
        .map(([author, metrics]) => ({
            author: author,
            commits: metrics.commits,
        }))
        .sort((a, b) => b.commits - a.commits);
        
    const finalMergedPrsData = Object.entries(finalMetrics)
        .map(([author, metrics]) => ({
            author: author,
            pullRequests: metrics.pullRequests,
        }))
        .sort((a, b) => b.pullRequests - a.pullRequests);
        
    const finalPrsReviewsData = Object.entries(finalMetrics)
        .map(([author, metrics]) => ({
            author: author,
            score: metrics.score,
        }))
        .sort((a, b) => b.score - a.score);
        
    const finalPrsRejectionsData = Object.entries(finalMetrics)
        .map(([author, metrics]) => ({
            author: author,
            rejections: metrics.rejections,
        }))
        .sort((a, b) => a.rejections - b.rejections);

    // Helper function to filter final data by user type
    const filterFinalDataByUserType = (data: any[], isQA: boolean) => {
        return data.filter(item => {
            const isUserQA = isQAUser(item.author);
            // If we want QA users, return QA users
            if (isQA) {
                return isUserQA;
            }
            // If we want Dev users, exclude QA users AND specifically excluded dev users
            else {
                return !isUserQA && !EXCLUDED_FROM_DEV_RANKING.has(item.author.toLowerCase());
            }
        });
    };

    // Create separate final datasets for QA and Dev users
    const qaFinalCommitsData = filterFinalDataByUserType(finalCommitsData, true);
    const qaFinalPrsData = filterFinalDataByUserType(finalMergedPrsData, true);
    const qaFinalReviewsData = filterFinalDataByUserType(finalPrsReviewsData, true);
    const qaFinalRejectionsData = filterFinalDataByUserType(finalPrsRejectionsData, true);

    const devFinalCommitsData = filterFinalDataByUserType(finalCommitsData, false);
    const devFinalPrsData = filterFinalDataByUserType(finalMergedPrsData, false);
    const devFinalReviewsData = filterFinalDataByUserType(finalPrsReviewsData, false);
    const devFinalRejectionsData = filterFinalDataByUserType(finalPrsRejectionsData, false);

    // Helper function to calculate positions with proper tie handling
    const calculatePositionsWithTies = (array: any[], valueKey: string): Map<string, number> => {
        const positions = new Map<string, number>();
        
        // Group users by their values
        const valueGroups = new Map<any, string[]>();
        array.forEach(item => {
            const value = item[valueKey];
            if (!valueGroups.has(value)) {
                valueGroups.set(value, []);
            }
            valueGroups.get(value)!.push(item.author);
        });
        
        // Sort values to assign positions correctly
        const sortedValues = Array.from(valueGroups.keys()).sort((a, b) => {
            // For rejections, lower is better (ascending)
            if (valueKey === 'rejections') return a - b;
            // For others, higher is better (descending)  
            return b - a;
        });
        
        let currentPosition = 1; // Start at position 1, not 0
        sortedValues.forEach(value => {
            const usersWithThisValue = valueGroups.get(value)!;
            // All users with same value get the SAME position (this fixes the tie issue)
            usersWithThisValue.forEach(user => {
                positions.set(user, currentPosition);
            });
            // Next position is just the next consecutive number (not jumping)
            // Example: 5 users at position 1, next user gets position 2 (consecutive)
            currentPosition += 1;
        });
        
        return positions;
    };

    // Generic ranking function with proper tie handling and tiebreakers
    const createRanking = (commits: any[], prs: any[], reviews: any[], rejections: any[]): RankedUser[] => {
        const rankingMap: { [key: string]: number } = {};

        // Calculate positions for each metric with tie handling
        const commitPositions = calculatePositionsWithTies(commits, 'commits');
        const prPositions = calculatePositionsWithTies(prs, 'pullRequests');  
        const reviewPositions = calculatePositionsWithTies(reviews, 'score');
        const rejectionPositions = calculatePositionsWithTies(rejections, 'rejections');

        // Create maps to get raw values for tiebreakers
        const commitValues = new Map<string, number>();
        const rejectionValues = new Map<string, number>();
        
        commits.forEach(c => commitValues.set(c.author, c.commits));
        rejections.forEach(r => rejectionValues.set(r.author, r.rejections));

        // Sum positions for each user
        const allUsers = new Set([
            ...commits.map(c => c.author),
            ...prs.map(p => p.author),
            ...reviews.map(r => r.author),
            ...rejections.map(r => r.author)
        ]);

        allUsers.forEach(user => {
            rankingMap[user] = 
                (commitPositions.get(user) || commits.length + 1) +
                (prPositions.get(user) || prs.length + 1) +
                (reviewPositions.get(user) || reviews.length + 1) +
                (rejectionPositions.get(user) || rejections.length + 1);
        });

        // Sort users by totalIndex with tiebreakers
        const sortedUsers = Object.entries(rankingMap)
            .map(([user, totalIndex]) => ({
                user, 
                totalIndex,
                rejections: rejectionValues.get(user) || 0,
                commits: commitValues.get(user) || 0
            }))
            .sort((a, b) => {
                // Primary sort: by totalIndex (ascending - lower is better)
                if (a.totalIndex !== b.totalIndex) {
                    return a.totalIndex - b.totalIndex;
                }
                
                // Tiebreaker 1: by rejections (ascending - fewer rejections is better)
                if (a.rejections !== b.rejections) {
                    return a.rejections - b.rejections;
                }
                
                // Tiebreaker 2: by commits (descending - more commits is better)
                return b.commits - a.commits;
            });
            
        // Assign final positions handling ties with tiebreakers
        const finalRanking: RankedUser[] = [];
        let currentRank = 1;
        
        // Track ties for logging
        const tieGroups = new Map<string, any[]>();
        
        for (let i = 0; i < sortedUsers.length; i++) {
            const currentUser = sortedUsers[i];
            const prevUser = i > 0 ? sortedUsers[i - 1] : null;
            
            // Check if this user should get a new rank (not tied with previous)
            const isNewRank = !prevUser || 
                currentUser.totalIndex !== prevUser.totalIndex ||
                currentUser.rejections !== prevUser.rejections ||
                currentUser.commits !== prevUser.commits;
            
            if (isNewRank && i > 0) {
                currentRank = i + 1;
            }
            
            // Create a key for grouping truly tied users (same totalIndex, rejections, and commits)
            const tieKey = `${currentUser.totalIndex}-${currentUser.rejections}-${currentUser.commits}`;
            if (!tieGroups.has(tieKey)) {
                tieGroups.set(tieKey, []);
            }
            tieGroups.get(tieKey)!.push({
                user: currentUser.user,
                totalIndex: currentUser.totalIndex,
                rejections: currentUser.rejections,
                commits: currentUser.commits,
                finalRank: currentRank
            });
            
            finalRanking.push({
                user: currentUser.user,
                totalIndex: currentUser.totalIndex,
                finalRank: currentRank
            });
        }
        
        // Log ties and tiebreaker information
        console.log("\n🏆 FINAL RANKING WITH TIEBREAKERS:");
        console.log("=".repeat(60));
        
        // Group by totalIndex for cleaner display
        const scoreGroups = new Map<number, any[]>();
        finalRanking.forEach(user => {
            const userData = sortedUsers.find(u => u.user === user.user)!;
            if (!scoreGroups.has(user.totalIndex)) {
                scoreGroups.set(user.totalIndex, []);
            }
            scoreGroups.get(user.totalIndex)!.push({
                ...user,
                rejections: userData.rejections,
                commits: userData.commits
            });
        });
        
        const sortedScores = Array.from(scoreGroups.keys()).sort((a, b) => a - b);
        sortedScores.forEach(totalIndex => {
            const usersWithThisScore = scoreGroups.get(totalIndex)!;
            console.log(`\n📊 Score ${totalIndex} points:`);
            
            if (usersWithThisScore.length === 1) {
                const user = usersWithThisScore[0];
                console.log(`   ${user.finalRank}. ${user.user} (${user.rejections} rejections, ${user.commits} commits)`);
            } else {
                // Show tiebreaker details
                console.log(`   ${usersWithThisScore.length} users with ${totalIndex} points:`);
                usersWithThisScore
                    .sort((a, b) => a.finalRank - b.finalRank)
                    .forEach(user => {
                        console.log(`   ${user.finalRank}. ${user.user} (${user.rejections} rejections, ${user.commits} commits)`);
                    });
            }
        });
        console.log("=".repeat(60));
        
        return finalRanking;
    };

    // Create final rankings using 12-week data
    qaRanking = createRanking(qaFinalCommitsData, qaFinalPrsData, qaFinalReviewsData, qaFinalRejectionsData);
    devRanking = createRanking(devFinalCommitsData, devFinalPrsData, devFinalReviewsData, devFinalRejectionsData);
    
    // Debug: Show alacret's individual positions in final data
    const alacretCommitPos = devFinalCommitsData.findIndex(u => u.author.toLowerCase() === 'alacret') + 1;
    const alacretPRPos = devFinalPrsData.findIndex(u => u.author.toLowerCase() === 'alacret') + 1;
    const alacretReviewPos = devFinalReviewsData.findIndex(u => u.author.toLowerCase() === 'alacret') + 1;
    const alacretRejectionPos = devFinalRejectionsData.findIndex(u => u.author.toLowerCase() === 'alacret') + 1;
    
    const alacretInDevRanking = devRanking.find(u => u.user.toLowerCase() === 'alacret');
    const alacretFinalPos = devRanking.findIndex(u => u.user.toLowerCase() === 'alacret') + 1;
    
    // Store debug info to show at the end
    debugInfo = {
        commits: alacretCommitPos || 'Not found',
        prs: alacretPRPos || 'Not found', 
        reviews: alacretReviewPos || 'Not found',
        rejections: alacretRejectionPos || 'Not found',
        totalIndex: alacretInDevRanking?.totalIndex || 'Not found',
        finalPosition: alacretFinalPos || 'Not found'
    };

    // Show ties verification for PR Rejections (most common ties)
    console.log("\n🔍 TIES VERIFICATION - PR Rejections (12-Week Data):");
    console.log("=".repeat(50));
    const rejectionGroups = new Map<number, string[]>();
    devFinalRejectionsData.forEach((user: any) => {
        const rejections = user.rejections;
        if (!rejectionGroups.has(rejections)) {
            rejectionGroups.set(rejections, []);
        }
        rejectionGroups.get(rejections)!.push(user.author);
    });
    
    const rejectionPositions = calculatePositionsWithTies(devFinalRejectionsData, 'rejections');
    const sortedRejectionValues = Array.from(rejectionGroups.keys()).sort((a, b) => a - b);
    
    sortedRejectionValues.forEach(rejectionCount => {
        const usersWithThisValue = rejectionGroups.get(rejectionCount)!;
        const position = rejectionPositions.get(usersWithThisValue[0]);
        console.log(`${rejectionCount} rejections: ${usersWithThisValue.length} users at position #${position}`);
        if (usersWithThisValue.length <= 5) {
            console.log(`  Users: ${usersWithThisValue.join(', ')}`);
        }
    });
    console.log("=".repeat(50));
    
    
    console.log(`✅ Final rankings calculated using 12-week period data only`);
    console.log(`📊 Final metrics for ${Object.keys(finalMetrics).length} users`);

        // Generate the labels report
        console.log("🏷️  Starting labels report generation...");
        const labelsReportPath = await generateLabelsReport(repoOwner);
        console.log("✅ Labels report generation completed!");
    
    // Show error handling statistics
    if (errorStats.skippedPRs > 0 || errorStats.cachedFallbackPRs > 0) {
        console.log(`\n📊 Error Handling Summary:`);
        if (errorStats.cachedFallbackPRs > 0) {
            console.log(`🔄 PRs recovered from cache: ${errorStats.cachedFallbackPRs}`);
        }
        if (errorStats.skippedPRs > 0) {
            console.log(`⚠️ PRs skipped (no data): ${errorStats.skippedPRs}`);
        }
        console.log(`✅ Report completed despite ${errorStats.skippedPRs + errorStats.cachedFallbackPRs} PR issues\n`);
    }

    // Show debug info at the end
    console.log("\n" + "=".repeat(60));
    console.log("🔍 DEBUG: alacret's positions in each Dev metric:");
    console.log("=".repeat(60));
    console.log(`- Commits: #${debugInfo.commits}`);
    console.log(`- PRs Merged: #${debugInfo.prs}`);
    console.log(`- PR Reviews: #${debugInfo.reviews}`);
    console.log(`- PR Rejections: #${debugInfo.rejections}`);
    console.log(`- Total Index Score: ${debugInfo.totalIndex}`);
    console.log(`- Final Dev Ranking: #${debugInfo.finalPosition}`);
    console.log("=".repeat(60));
        
        // Send the reports via email
    console.log("📧 Preparing to send email with both reports...");
    // Save the Excel file to disk
    xlsx.writeFile(workbook, FILE_PATH, {bookType: "xlsx"});
    console.log(`📄 Excel file saved: ${FILE_PATH}`);
    
    // Verify files exist before sending email
    const fs = await import('fs');
    const mainFileExists = fs.existsSync(FILE_PATH);
    const labelsFileExists = labelsReportPath ? fs.existsSync(labelsReportPath) : false;
    console.log(`📋 File verification:`);
    console.log(`   Main report (${FILE_PATH}): ${mainFileExists ? '✅ EXISTS' : '❌ MISSING'}`);
    console.log(`   Labels report (${labelsReportPath}): ${labelsFileExists ? '✅ EXISTS' : '❌ MISSING'}`);
    
    // Send email with file paths (not buffer)
    await sendEmailWithAttachments(undefined, qaRanking, devRanking, closedIssuesQARanking, closedIssuesDevRanking, labelsReportPath);
    console.log("✅ Email sent successfully! Script should complete now.");
        
    } catch (error) {
        console.error("❌ Error generating report:", error);
        throw error;
    } finally {
        // Close all cache connections gracefully
        await closeAllCaches();
    }
}









