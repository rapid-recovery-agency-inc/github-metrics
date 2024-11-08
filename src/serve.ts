import express, {Request, Response} from "express";
import morgan from "morgan";
import {generateReport} from "./index";

const app = express()
const port = process.env.PORT ?? 3000;

if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_ORG) {
    console.error("Please set GITHUB_TOKEN and GITHUB_ORG in .env file");
    process.exit(1);
}

const repoOwner = `${process.env.GITHUB_ORG}`;

app.use(morgan('dev'));

app.get('/github-metric-report', async (req: Request, res: Response) => {
    console.log("Generating GitHub metrics report...");
    await generateReport(repoOwner);
    res.send('Hello World!')
})

app.post('/github-metric-report', async (req: Request, res: Response) => {
    console.log("Generating GitHub metrics report...");
    await generateReport(repoOwner,);
    res.send('Hello World!')
})

app.get('*', (req: Request, res: Response) => {
    console.log("404 Not Found:", req.url);
    res.status(404).send('Not Found'); // Or render a 404 page
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})
