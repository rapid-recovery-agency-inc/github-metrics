export interface DateInterval {
    since: string;
    until: string;
}

export interface GraphQLCommit {
    committedDate: string;
    oid: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    message: string;
    author?: {
        name: string;
        email: string;
    }
    authors?:{
        nodes:{
            user:{
                login: string;
            } | null
        }[]
    };
};

interface PageInfo  {
    hasNextPage: boolean;
    endCursor: string;
};

export interface GraphQLRepositoryNode {
    node: {
        name?: string;
        defaultBranchRef?: {
            target: {
                history: {
                    pageInfo: PageInfo
                    edges: {
                        node: GraphQLCommit
                    }[]
                }
            }
        } | null
    }
}

export interface GraphQLCommitsResponse {
    data: {
        repository: {
            defaultBranchRef: {
                target: {
                    history: {
                        edges: {
                            node: GraphQLCommit
                        }[]
                        pageInfo: PageInfo;
                    }
                }
            };
        }
    }
    errors: any[];
}

export interface GraphQLRepositoriesResponse {
    data: {
        repositoryOwner: {
            repositories: {
                edges: GraphQLRepositoryNode[]
                pageInfo: PageInfo;
            };
        }
    }
    errors: any[];
}

export interface RestIssueAndPullRequest {
    number: number;
    repository_url: string;
    html_url: string;
    title: string;
    user: {
        login: string;
    }
    state: string;
    created_at: string;
    closed_at: string;
    pull_request: any;
}

export interface ReviewsForPullRequest {
    reviews: GraphQLReview[];
    reviewThreads: GraphQLReviewThread[]
}

export interface GraphQLReview {
    author?:{
        login: string;
    }
}

export interface GraphQLReviewNode {
    pageInfo: PageInfo;
    edges: {
        node: GraphQLReview
    }[]
}

export interface GraphQLReviewThread {
    comments?: {
        edges:{
            node: {
                author?:{
                    login: string;
                }
            }
        }[]
    }
}

export interface GraphQLReviewThreadNode {
    edges: {
        node: GraphQLReviewThread
    }[]
}

export interface AggregateCommits {
    additions: number;
    deletions: number;
}

export interface AggregateMetrics {
    commits: number;
    pullRequests: number;
    reviews: number;
    score: number;
}
