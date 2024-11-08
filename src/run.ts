import {generateReport} from "./index";


if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_ORG) {
    console.error("Please set GITHUB_TOKEN and GITHUB_ORG in .env file");
    process.exit(1);
}

const repoOwner = `${process.env.GITHUB_ORG}`;


await generateReport(repoOwner);
