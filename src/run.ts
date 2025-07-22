import {generateReport} from "./index";

console.log("🚀 Starting GitHub Metrics generation...");

if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_ORG) {
    console.error("❌ Please set GITHUB_TOKEN and GITHUB_ORG in .env file");
    process.exit(1);
}

const repoOwner = `${process.env.GITHUB_ORG}`;
console.log(`📊 Generating report for organization: ${repoOwner}`);

try {
    await generateReport(repoOwner);
    console.log("✅ Report generation completed successfully!");
} catch (error) {
    console.error("❌ Error generating report:", error);
    console.error("Stack trace:", error instanceof Error ? error.stack : "Unknown error");
    process.exit(1);
}
