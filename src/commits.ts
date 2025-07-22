import {AggregateCommits, GraphQLCommit, GraphQLCommitsResponse} from "./types";
import {sleep} from "./utils";
import {COMMITS_CACHE} from "./cache";
import fetch from "node-fetch";
import { GITHUB_GRAPHQL_API} from "./constants";

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
    console.log("DEBUG:fetchCommits:", repoOwner, repository, since, until);
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
                    continue;
                }
            }
            const result: GraphQLCommitsResponse = (await response.json()) as GraphQLCommitsResponse;
            if (result.errors) {
                console.error("GraphQL errors:fetchCommitsInDateRange:", result.errors, response.headers);
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
    console.log("DEBUG:fetchCommitsInDateRange:", repoOwner, repositories, startDate, endDate);
    const allCommits: GraphQLCommit[] = [];
    for (const repository of repositories) {
        const commits = await fetchCommits(repoOwner, repository, startDate.toISOString(), endDate.toISOString());
        allCommits.push(...commits);
    }
    const deduplicatedCommitsMap = new Map<string, GraphQLCommit>();
    allCommits.forEach((commit) => {
        deduplicatedCommitsMap.set(commit.oid, commit);
    });
    return Array.from(deduplicatedCommitsMap.values());
}


export const aggregateCommits = (commits: GraphQLCommit[]): Record<string, AggregateCommits> => {
    // Lista de usuarios problemáticos para debuggear
    const USERS_TO_DEBUG = ['juansebasmarin', 'anjelysleal', 'nicolas-toledo'];
    
    console.log("🔍 DEBUG: aggregateCommits - Total commits a procesar:", commits.length);
    
    const aggregate: Record<string, AggregateCommits> = {};
    commits.forEach((commit, index) => {
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
        
        // Debug: Verificar si este commit es de uno de nuestros usuarios problemáticos
        if (USERS_TO_DEBUG.some(user => user.toLowerCase() === author.toLowerCase()) || 
            USERS_TO_DEBUG.some(user => commit.author?.name?.toLowerCase().includes(user.toLowerCase())) ||
            USERS_TO_DEBUG.some(user => commit.author?.email?.toLowerCase().includes(user.toLowerCase()))) {
            console.log(`🔍 DEBUG: aggregateCommits - Commit ${index + 1} de usuario problemático:`, {
                author,
                oid: commit.oid,
                authorFromLogin: commit.authors?.nodes?.[0]?.user?.login,
                authorFromName: commit.author?.name,
                authorFromEmail: commit.author?.email,
                additions: commit.additions,
                deletions: commit.deletions,
                message: commit.message?.substring(0, 50)
            });
        }
        
        const record: AggregateCommits = aggregate[author] ?? {
            additions: 0,
            deletions: 0,
        };
        record.additions += commit.additions ?? 0;
        record.deletions += commit.deletions ?? 0;
        aggregate[author] = record;
    });
    
    // Debug: Verificar resultado de agregación para usuarios problemáticos
    console.log("🔍 DEBUG: aggregateCommits - Resultado para usuarios problemáticos:");
    USERS_TO_DEBUG.forEach(user => {
        const found = Object.keys(aggregate).find(key => 
            key.toLowerCase() === user.toLowerCase()
        );
        if (found) {
            console.log(`✅ DEBUG: aggregateCommits - Usuario ${user} encontrado como "${found}":`, aggregate[found]);
        } else {
            console.log(`❌ DEBUG: aggregateCommits - Usuario ${user} NO encontrado`);
        }
    });
    
    return aggregate;
}
