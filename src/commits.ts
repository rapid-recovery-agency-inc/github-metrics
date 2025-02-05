import {AggregateCommits, GraphQLCommit, GraphQLCommitResponse} from "./types";
import {getDateIntervals, sleep} from "./utils";
import {COMMITS_CACHE} from "./cache";
import fetch from "node-fetch";
import {COMMITS_QUERY} from "./graphql-queries";
import {DAYS_IN_INTERVAL, GITHUB_GRAPHQL_API} from "./constants";


export const fetchCommitsInDateRange = async (
    repoOwner: string,
    startDate: Date,
    endDate: Date
): Promise<GraphQLCommit[]> => {
    console.log("DEBUG:fetchCommitsInDateRange:", repoOwner, startDate, endDate);
    const allCommits: GraphQLCommit[] = [];
    const dateIntervals = getDateIntervals(startDate, endDate, DAYS_IN_INTERVAL);
    console.log("DEBUG:fetchCommitsInDateRange:dateIntervals:", dateIntervals);
    for (const {since, until} of dateIntervals) {
        const cacheKey = `${repoOwner}-${since}-${until}`;
        const cachedResult = COMMITS_CACHE.get<GraphQLCommit[]>(cacheKey);
        if (cachedResult) {
            allCommits.push(...cachedResult);
            continue;
        }
        let cursor: string | null = null;
        let hasMore = true;
        const theseDatesCommits: GraphQLCommit[] = [];
        mainLoop:
            while (hasMore) {
                const variables = {repoOwner, since, until, cursor};
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
                const result: GraphQLCommitResponse = (await response.json()) as GraphQLCommitResponse;
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
                const repositories = result.data.repositoryOwner.repositories.edges;
                for (const repo of repositories) {
                    if (!repo.node.defaultBranchRef) continue;
                    const history = repo.node.defaultBranchRef.target.history;
                    const commits = history.edges.map((edge) => edge.node);
                    if (commits.length > 0) {
                        theseDatesCommits.push(...commits);
                    }
                    hasMore = history.pageInfo.hasNextPage;
                    cursor = history.pageInfo.endCursor;
                }
            }
        allCommits.push(...theseDatesCommits);
        COMMITS_CACHE.set(cacheKey, theseDatesCommits);
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
