import {AggregateCommits, GraphQLCommit, GraphQLCommitsResponse} from "./types";
import {getDateIntervals, sleep} from "./utils";
import {COMMITS_CACHE} from "./cache";
import fetch from "node-fetch";
import {DAYS_IN_INTERVAL, GITHUB_GRAPHQL_API} from "./constants";

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
            console.log("DEBUG:fetchCommits:response:", result);
            console.log("DEBUG:fetchCommits:response:", result.data);
            console.log("DEBUG:fetchCommits:response:", result.data.repository);
            console.log("DEBUG:fetchCommits:response:", result.data.repository.defaultBranchRef);
            console.log("DEBUG:fetchCommits:response:", result.data.repository.defaultBranchRef.target);
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
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    console.log("DEBUG:fetchCommitsInDateRange:dateIntervals:", dateIntervals);

    for (const repository of repositories) {
        for (const {since, until} of dateIntervals) {
            const commits = await fetchCommits(repoOwner, repository, since, until);
            allCommits.push(...commits);
        }
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
