export const COMMITS_QUERY = `
query($repoOwner: String!, $since: GitTimestamp, $until: GitTimestamp, $cursor: String) {
    repositoryOwner(login: $repoOwner) {
        repositories(first: 50) {
            edges {
                node {
                    name
                    defaultBranchRef {
                        target {
                        ... on Commit {
                                history(first: 40, since: $since, until: $until, after: $cursor) {
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
        }
    }
}
`;
