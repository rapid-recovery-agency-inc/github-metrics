import {AggregateCommits, GraphQLCommit, GraphQLCommitsResponse} from "./types";
import {sleep, retryWithBackoff} from "./utils";
import {COMMITS_CACHE} from "./cache";
import fetch from "node-fetch";
import { GITHUB_GRAPHQL_API, EXCLUDED_FROM_RANKINGS} from "./constants";

const COMMITS_QUERY = `
    query($repoOwner: String!, $repository:String!, $since: GitTimestamp, $until: GitTimestamp, $cursor: String) {
        repository(owner:$repoOwner, name:$repository){
            defaultBranchRef {
                target {
                ... on Commit {
                   history(first: 100, since: $since, until: $until, after: $cursor) {
                     edges {
                       node {
                         oid
                         committedDate
                         additions
                         deletions
                         changedFiles
                         message
                         authors(first:1){
                           nodes{
                           user{
                            login
                           }
                           }
                          }
                         author {
                           name
                           email
                         }
                       }
                     }
                     pageInfo {
                       hasNextPage
                       endCursor
                     }
                   }
                 }
                }
            }
        }
    }
`;

const fetchCommits = async (
    repoOwner: string,
    repository: string,
    since: string,
    until: string,
): Promise<GraphQLCommit[]> => {
    const allCommits: GraphQLCommit[] = [];
    const cacheKey = `${repoOwner}-${repository}-${since}-${until}`;
    const cachedResult = COMMITS_CACHE.get<GraphQLCommit[]>(cacheKey);
    if (cachedResult) {
        return cachedResult;
    }
    //
    let cursor: string | null = null;
    let hasMore = true;
    const theseDatesCommits: GraphQLCommit[] = [];
    mainLoop:
        while (hasMore) {
            const variables = {repoOwner, repository, since, until, cursor};
            
            const result = await retryWithBackoff(async () => {
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
                        await sleep(waitTime);
                        throw new Error("Rate limit exceeded, will retry after delay");
                    }
                }
                
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }
                
                const contentType = response.headers.get("content-type");
                if (!contentType || !contentType.includes("application/json")) {
                    const errorText = await response.text();
                    throw new Error(`Expected JSON response, got ${contentType}: ${errorText.substring(0, 200)}`);
                }
                
                return await response.json() as GraphQLCommitsResponse;
            }, 5, 3000, `fetchCommits(${repository})`);
            if (result.errors) {
                console.error("GraphQL errors:fetchCommitsInDateRange:", result.errors);
                for (let i = 0; i < result.errors.length; i++) {
                    const error = result.errors[i];
                    if (error.type === "RATE_LIMITED") {
                        continue mainLoop;
                    }
                }
                throw new Error(result.errors.map((error) => error.type).join(", "));
            }
            if (!result.data.repository.defaultBranchRef) {
                return [];
            }
            const {edges, pageInfo} = result.data.repository.defaultBranchRef.target.history;
            for (const commit of edges) {
                allCommits.push(commit.node);
            }
            hasMore = pageInfo.hasNextPage;
            cursor = pageInfo.endCursor;
        }
    allCommits.push(...theseDatesCommits);
    COMMITS_CACHE.set(cacheKey, theseDatesCommits);
    return allCommits;
}

export const fetchCommitsInDateRange = async (
    repoOwner: string,
    repositories: string[],
    startDate: Date,
    endDate: Date
): Promise<GraphQLCommit[]> => {
    const allCommits: GraphQLCommit[] = [];
    let failedRepos = 0;
    
    for (const repository of repositories) {
        try {
            const commits = await fetchCommits(repoOwner, repository, startDate.toISOString(), endDate.toISOString());
            allCommits.push(...commits);
        } catch (error) {
            console.error(`❌ Failed to fetch commits from ${repository}:`, error instanceof Error ? error.message : String(error));
            failedRepos++;
            // Continue with other repositories
        }
    }
    
    if (failedRepos > 0) {
        console.log(`⚠️  ${failedRepos} repositories failed during commit fetching, continuing with available data...`);
    }
    
    const deduplicatedCommitsMap = new Map<string, GraphQLCommit>();
    allCommits.forEach((commit) => {
        deduplicatedCommitsMap.set(commit.oid, commit);
    });
    return Array.from(deduplicatedCommitsMap.values());
}


export const aggregateCommits = (commits: GraphQLCommit[]): Record<string, AggregateCommits> => {
    const aggregate: Record<string, AggregateCommits> = {};
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
        
        // Skip excluded users from rankings  
        if (EXCLUDED_FROM_RANKINGS.has(author.toLowerCase())) {
            return;
        }
        
        const record: AggregateCommits = aggregate[author] ?? {
            additions: 0,
            deletions: 0,
        };
        record.additions += commit.additions ?? 0;
        record.deletions += commit.deletions ?? 0;
        aggregate[author] = record;
    });
    return aggregate;
}
