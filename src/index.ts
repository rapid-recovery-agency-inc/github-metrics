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
    ReviewsForPullRequest
} from "./types";
import {sendTemplateEmail} from "./email.js";
import {PRS_CACHE, PRS_REVIEW_CACHE} from "./cache.js";
import {AUTHOR_ALIAS_MAP, BLACKLISTED_CODE_USERS, DAYS_IN_INTERVAL, GITHUB_GRAPHQL_API} from "./constants";
import {aggregateCommits, fetchCommitsInDateRange} from "./commits";
import {debugToFile} from "./debug";
import {fetchRepositories} from "./repositories";


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

// The PERIODS to generate reports for
const PERIODS: Record<number, string> = {
    2: "Last 2 Weeks",
    4: "Last 4 Weeks",
    6: "Last 6 Weeks",
    12: "Last 12 Weeks",
};

const MAX_RETRIES = 3;


// Function to fetch all commits within a given date range using date intervals


// Function to fetch all pull requests within a given date range using date intervals
async function fetchPullRequestsInDateRange(
    repoOwner: string,
    startDate: Date,
    endDate: Date
) {
    console.log("DEBUG:fetchPullRequestsInDateRange:", repoOwner, startDate, endDate);
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
const aggregateMetricsByDateRange = async (
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<Record<string, AggregateMetrics>> => {
    // Lista de usuarios problemáticos para debuggear
    const USERS_TO_DEBUG = ['juansebasmarin', 'anjelysleal', 'nicolas-toledo'];
    
    console.log("🔍 DEBUG: Iniciando agregación de métricas para el periodo:", startDate.toISOString(), "hasta", endDate.toISOString());
    console.log("🔍 DEBUG: Usuarios que vamos a rastrear específicamente:", USERS_TO_DEBUG);
    
    const rawUserMetrics: Record<string, AggregateMetrics> = {};
    const commits = await fetchCommitsInDateRange(repoOwner, repositories, startDate, endDate);
    const pullRequests = await fetchPullRequestsInDateRange(
        repoOwner,
        startDate,
        endDate
    );
    
    // Debug: Verificar commits de usuarios específicos
    console.log("🔍 DEBUG: Total commits obtenidos:", commits.length);
    USERS_TO_DEBUG.forEach(user => {
        const userCommits = commits.filter(commit => {
            // Verificar en authors.nodes[].user.login
            const hasUserLogin = commit.authors?.nodes?.some(node => 
                node.user?.login?.toLowerCase() === user.toLowerCase()
            );
            // Verificar en author.name y author.email
            const hasAuthorName = commit.author?.name?.toLowerCase().includes(user.toLowerCase());
            const hasAuthorEmail = commit.author?.email?.toLowerCase().includes(user.toLowerCase());
            
            return hasUserLogin || hasAuthorName || hasAuthorEmail;
        });
        console.log(`🔍 DEBUG: Commits encontrados para ${user}:`, userCommits.length);
        if (userCommits.length > 0) {
            console.log(`🔍 DEBUG: Detalles de commits para ${user}:`, userCommits.map(c => ({
                oid: c.oid,
                authorLogins: c.authors?.nodes?.map(n => n.user?.login).filter(Boolean),
                authorName: c.author?.name,
                authorEmail: c.author?.email,
                committedDate: c.committedDate
            })));
        }
    });
    
    const aggregatedCommits = aggregateCommits(commits);
    
    // Debug: Verificar si los usuarios están en aggregatedCommits
    USERS_TO_DEBUG.forEach(user => {
        const found = Object.keys(aggregatedCommits).find(key => 
            key.toLowerCase() === user.toLowerCase()
        );
        if (found) {
            console.log(`🔍 DEBUG: Usuario ${user} encontrado en aggregatedCommits como "${found}":`, aggregatedCommits[found]);
        } else {
            console.log(`❌ DEBUG: Usuario ${user} NO encontrado en aggregatedCommits`);
        }
    });
    
    Object.entries(aggregatedCommits).forEach(([author, data]) => {
        rawUserMetrics[author] = {
            commits: data.additions + data.deletions,
            pullRequests: 0,
            reviews: 0,
            score: 0,
        };
    });
    console.log("DEBUG:aggregatedCommits:", aggregatedCommits);
    console.log("DEBUG:rawUserMetrics:", rawUserMetrics);
    
    // Debug: Verificar PRs de usuarios específicos
    console.log("🔍 DEBUG: Total PRs obtenidos:", pullRequests.length);
    USERS_TO_DEBUG.forEach(user => {
        const userPRs = pullRequests.filter(pr => 
            pr.user?.login?.toLowerCase() === user.toLowerCase()
        );
        console.log(`🔍 DEBUG: PRs encontrados para ${user}:`, userPRs.length);
        if (userPRs.length > 0) {
            console.log(`🔍 DEBUG: Detalles de PRs para ${user}:`, userPRs.map(pr => ({
                number: pr.number,
                title: pr.title,
                user: pr.user?.login,
                created_at: pr.created_at,
                repository_url: pr.repository_url
            })));
        }
    });
    
    for (const pr of pullRequests) {
        const author = pr.user?.login || "Unknown";
        const repoName = `${pr.repository_url.split("/").pop()}`;
        rawUserMetrics[author] = rawUserMetrics[author] || {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            score: 0,
        };
        // Increment the number of PRs raised
        rawUserMetrics[author].pullRequests += 1;
        
        // Debug: Verificar si este PR es de un usuario problemático
        if (USERS_TO_DEBUG.some(user => user.toLowerCase() === author.toLowerCase())) {
            console.log(`🔍 DEBUG: Procesando PR de ${author} - ${pr.title} (#${pr.number})`);
        }
        
        // Fetch reviews for the current PR
        const {reviews, reviewThreads} = await fetchReviewsForPR(repoOwner, repoName, pr.number);
        
        // Debug: Verificar reviews de usuarios específicos
        const debugReviews = reviews.filter(review => 
            USERS_TO_DEBUG.some(user => 
                review.author?.login?.toLowerCase() === user.toLowerCase()
            )
        );
        if (debugReviews.length > 0) {
            console.log(`🔍 DEBUG: Reviews encontrados en PR #${pr.number}:`, debugReviews.map(r => ({
                author: r.author?.login
            })));
        }
        
        reviews.forEach((review) => {
            const reviewer = review.author?.login || "Unknown";
            rawUserMetrics[reviewer] = rawUserMetrics[reviewer] || {
                commits: 0,
                pullRequests: 0,
                reviews: 0,
                score: 0,
            };
            // Increment the number of reviews by the user
            rawUserMetrics[reviewer].reviews += 1;
            // Add 1 point for the review
            rawUserMetrics[reviewer].score += 1;

            reviewThreads.forEach((reviewThread) => {
                const threadAuthor = reviewThread?.comments?.edges[0]?.node?.author?.login ?? 'Unknown';
                rawUserMetrics[threadAuthor] = rawUserMetrics[threadAuthor] || {
                    commits: 0,
                    pullRequests: 0,
                    reviews: 0,
                    score: 0,
                };
                rawUserMetrics[threadAuthor].score += 0.1;
            })
        });
    }
    
    // Debug: Verificar si los usuarios están en rawUserMetrics después de procesar todo
    console.log("🔍 DEBUG: Verificando usuarios en rawUserMetrics después de procesar:");
    USERS_TO_DEBUG.forEach(user => {
        const found = Object.keys(rawUserMetrics).find(key => 
            key.toLowerCase() === user.toLowerCase()
        );
        if (found) {
            console.log(`🔍 DEBUG: Usuario ${user} encontrado en rawUserMetrics como "${found}":`, rawUserMetrics[found]);
        } else {
            console.log(`❌ DEBUG: Usuario ${user} NO encontrado en rawUserMetrics`);
        }
    });
    
    console.log("DEBUG:rawUserMetrics:", rawUserMetrics);
    const mergedUserMetrics: Record<string, AggregateMetrics> = {};
    Object.entries(rawUserMetrics).forEach(([author, data]) => {
        const normalizedAuthor = author.toLowerCase();
        
        // Debug: Verificar si es uno de nuestros usuarios problemáticos
        if (USERS_TO_DEBUG.some(user => user.toLowerCase() === normalizedAuthor)) {
            console.log(`🔍 DEBUG: Procesando usuario problemático "${author}" -> normalizado a "${normalizedAuthor}"`);
        }
        
        if (BLACKLISTED_CODE_USERS.has(author)) { // Ignore metrics for blacklisted users
            if (USERS_TO_DEBUG.some(user => user.toLowerCase() === normalizedAuthor)) {
                console.log(`❌ DEBUG: Usuario ${author} está en BLACKLIST y será ignorado!`);
            }
            return;
        }
        
        const aliasAuthor = AUTHOR_ALIAS_MAP.get(normalizedAuthor);
        const realAuthor = aliasAuthor ?? normalizedAuthor;
        
        // Debug: Verificar alias mapping
        if (USERS_TO_DEBUG.some(user => user.toLowerCase() === normalizedAuthor)) {
            console.log(`🔍 DEBUG: Usuario ${author} -> normalizado: ${normalizedAuthor} -> alias: ${aliasAuthor} -> realAuthor: ${realAuthor}`);
        }
        
        const record = mergedUserMetrics[realAuthor] ?? {
            commits: 0,
            pullRequests: 0,
            reviews: 0,
            score: 0,
        };
        record.commits += data.commits;
        record.pullRequests += data.pullRequests;
        record.reviews += data.reviews;
        record.score += data.score;
        mergedUserMetrics[realAuthor] = record;
    });
    
    // Debug: Verificar resultado final
    console.log("🔍 DEBUG: Verificando usuarios en mergedUserMetrics (resultado final):");
    USERS_TO_DEBUG.forEach(user => {
        const found = Object.keys(mergedUserMetrics).find(key => 
            key.toLowerCase() === user.toLowerCase()
        );
        if (found) {
            console.log(`✅ DEBUG: Usuario ${user} encontrado en resultado final como "${found}":`, mergedUserMetrics[found]);
        } else {
            console.log(`❌ DEBUG: Usuario ${user} NO encontrado en resultado final`);
        }
    });
    
    console.log("DEBUG:mergedUserMetrics:", mergedUserMetrics);
    return mergedUserMetrics;
}

// Function to send an email with the report attached
async function sendEmailWithAttachment(attachment: Buffer, aggregateRanking: RankedUser[]) {
    // Lista de usuarios problemáticos para debuggear
    const USERS_TO_DEBUG = ['juansebasmarin', 'anjelysleal', 'nicolas-toledo'];
    
    console.log("🔍 DEBUG: EMAIL - Ranking agregado final que se enviará:");
    aggregateRanking.forEach((rank, index) => {
        const isDebugUser = USERS_TO_DEBUG.some(user => user.toLowerCase() === rank.user.toLowerCase());
        const prefix = isDebugUser ? "🎯" : "  ";
        console.log(`${prefix} ${index + 1}. ${rank.user} (totalIndex: ${rank.totalIndex})`);
    });
    
    // Verificar específicamente nuestros usuarios problemáticos
    console.log("🔍 DEBUG: EMAIL - Verificando usuarios problemáticos en ranking final:");
    USERS_TO_DEBUG.forEach(user => {
        const found = aggregateRanking.find(rank => 
            rank.user.toLowerCase() === user.toLowerCase()
        );
        if (found) {
            const position = aggregateRanking.indexOf(found) + 1;
            console.log(`✅ DEBUG: ${user} encontrado en posición ${position} con totalIndex ${found.totalIndex}`);
        } else {
            console.log(`❌ DEBUG: ${user} NO encontrado en ranking final`);
        }
    });
    
    const rankedListString = aggregateRanking.map((rank, index) => {
        return `${index + 1}.  ${rank.user} <br/>`;
    }).join('\n');
    
    const recipients = [
        {email: 'estebanpersonal20@gmail.com'}, // Added for testing
        // {email: 'alacret@insightt.io'},
        // {email: 'ysouki@insightt.io'},
        // {email: 'bhamilton@insightt.io'},
        // {email: 'lpena@insightt.io'}
    ];
    
    console.log(`📧 Sending email to ${recipients.length} recipients:`);
    recipients.forEach((user, index) => {
        console.log(`   ${index + 1}. ${user.email}`);
    });
    
    try {
        await sendTemplateEmail({
            users: recipients,
            subject: "GitHub Metrics Report",
            body: `${rankedListString}`,
            attachments: [
                {
                    filename: FILE_PATH,
                    path: FILE_PATH,
                }
            ]
        });
        console.log(`✅ Email sent successfully to all recipients`);
    } catch (error) {
        console.error(`❌ Error sending email:`, error);
        throw error;
    }
}


// Function to generate reports for multiple time PERIODS
export async function generateReport(
    repoOwner: string,
) {
    const repositories = await fetchRepositories(repoOwner);
    //
    const workbook = xlsx.utils.book_new();
    const endDate = new Date();
    // We need to start from yesterday
    endDate.setDate(endDate.getDate() - 1);
    let rankedUsers: RankedUser[] = [];

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
        console.log("DEBUG:commitsData:", commitsData);
        console.log("DEBUG:mergedPrsData:", mergedPrsData);
        console.log("DEBUG:prsReviewsData:", prsReviewsData);
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
        const maxRows = Math.max(commitsData.length, mergedPrsData.length, prsReviewsData.length);
        for(let i = 0; i < maxRows; i++) {
            sheetData.push([
                i < commitsData.length ? `${i + 1}.  ${commitsData[i].author}` : "",
                i < commitsData.length ? `${commitsData[i].commits}` : "",
                i < mergedPrsData.length ? `${i + 1}.  ${mergedPrsData[i].author}` : "",
                i < mergedPrsData.length ? `${mergedPrsData[i].pullRequests}` : "",
                i < prsReviewsData.length ? `${i + 1}.  ${prsReviewsData[i].author}` : "",
                i < prsReviewsData.length ? `${parseFloat(prsReviewsData[i].score.toFixed(1))}` : "",
            ]);
        }

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
    console.log(`✅ Excel report generated successfully: ${FILE_PATH}`);
    console.log(`📧 Email sending disabled - configure AWS credentials to enable email`);
    await sendEmailWithAttachment(attachment, rankedUsers);
}







