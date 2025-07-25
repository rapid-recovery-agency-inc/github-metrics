import {GraphQLRepositoriesResponse} from "./types";
import {sleep} from "./utils";
import fetch from "node-fetch";
import {GITHUB_GRAPHQL_API} from "./constants";

const REPOSITORIES_QUERY = `
    query($repoOwner: String!, , $cursor: String) {
        repositoryOwner(login: $repoOwner) {
            repositories(first: 100, after:$cursor) {
                edges {
                    node {
                        name         
                    }
                }
                pageInfo {
                    hasNextPage
                    endCursor
                }
            }
        }
    }`;

export const fetchRepositories = async (
    repoOwner: string,
): Promise<string[]> => {
    const allRepositories: string[] = [];
    let cursor: string | null = null;
    let hasMore = true;
    mainLoop:
        while (hasMore) {
            const variables = {repoOwner, cursor};
            const response = await fetch(GITHUB_GRAPHQL_API, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
                },
                body: JSON.stringify({
                    query: REPOSITORIES_QUERY,
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
            const result: GraphQLRepositoriesResponse = (await response.json()) as GraphQLRepositoriesResponse;
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
            const {edges, pageInfo} = result.data.repositoryOwner.repositories;
            for (const repository of edges) {
                if (repository.node)
                    allRepositories.push(repository.node.name!);
            }
            hasMore = pageInfo.hasNextPage;
            cursor = pageInfo.endCursor;
        }
    return allRepositories;
}
