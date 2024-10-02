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
            }
        }[]
    };
};

interface PageInfo  {
    hasNextPage: boolean;
    endCursor: string;
};

export interface GraphQLRepositoryNode {
    node: {
        defaultBranchRef: {
            target: {
                history: {
                    pageInfo: PageInfo
                    edges: {
                        node: GraphQLCommit
                    }[]
                }
            }
        }
    }
}

export interface GraphQLCommitResponse {
    data: {
        repositoryOwner: {
            repositories: {
                edges: GraphQLRepositoryNode[]
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
