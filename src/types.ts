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
    state: string;
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
    rejections: number;
    score: number;
    bugLabels: number;
    enhancementLabels: number;
    otherLabels: number;
}

export interface RestIssue {
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
    assignees?: {
        login: string;
    }[];
    assignee?: {
        login: string;
    } | null;
    labels: {
        name: string;
        color: string;
    }[];
}

export interface ClosedIssue extends RestIssue {
    state: 'closed';
    closed_at: string;
}

export interface IssueComment {
    user: {
        login: string;
    };
    created_at: string;
    body: string;
}

export interface IssueParticipation {
    issueNumber: number;
    repository: string;
    assignees: string[];
    commenters: string[];
    prMentioners: string[];
}

export interface RankedUser {
    user: string;
    totalIndex: number;
}

export interface ClosedIssueRankedUser extends RankedUser {
    participation?: number;
}

export interface IssueEvent {
    event: string;
    created_at: string;
    actor: {
        login: string;
    } | null;
    label?: {
        name: string;
        color: string;
    };
}

export interface LabelMetrics {
    bugLabels: number;
    enhancementLabels: number;
    otherLabels: number;
}

export interface RepoLabelMetrics {
    [repoName: string]: LabelMetrics;
}
