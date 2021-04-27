import puppeteer, { Browser, Page } from 'puppeteer';
import chromium from 'chrome-aws-lambda';
import aws from 'aws-sdk';

const documentClient = new aws.DynamoDB.DocumentClient();
const s3 = new aws.S3();
const bucket = "screenshot-audible";
const key = "audible.png";
const { v4: uuidv4 } = require('uuid');

exports.handler = async () => {
    const args = [];
    args.push(...chromium.args);
    const cookies = [
        process.env.jordanCookie,
        // process.env.jonCookie,
        process.env.ashliCookie
    ];
    for (let i = 0; i < cookies.length; i++) {

        const browser = await chromium.puppeteer.launch({
            args: args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        try {
            const bookDetails = await getBookDetails(browser, cookies[i]);
            await browser.close();

            return bookDetails;

        } catch (e) {
            const screenshot = await e.page.screenshot();
            const params = { Bucket: bucket, Key: key, Body: screenshot };
            await s3.putObject(params).promise();
            console.log('something happened See screenshot in s3 bucket', e.error);
            await browser.close();
            return e.error;
        }
    }
}

async function getBookDetails(browser: any, cookies: string) {
    const url = 'https://www.audible.com/';

    const page = await auth(browser, cookies);
    try {
        let pageNumberLast: number;
        try {
            pageNumberLast = +await page.$eval('.linkListWrapper li:nth-last-of-type(2) .bc-link', element => element.getAttribute('data-value'));
        } catch (e) {
            pageNumberLast = 2;
        }
        // const pageNumberLast: number = +await page.$eval('.linkListWrapper li:nth-last-of-type(2) .bc-link', element => element.getAttribute('data-value'));
        console.log('page number', pageNumberLast);
        let owner = await page.$eval('.bc-text.navigation-do-underline-on-hover.ui-it-barker-text', element => element.textContent);
        owner = owner.split(',')[1].replace('!', '').trim();

        let pageNumber: number = 1;

        const existingTitles = await scanTitles();

        const bookData: any[] = [];
        while (pageNumber <= pageNumberLast) {
            await page.goto(`${url}/library/titles?ref=a_library_t_c6_pageSize_0&pf_rd_p=754864b9-4c5c-4301-b92a-69b12a5623c4&pf_rd_r=2793CX9HNJGABE75EYEX&piltersCurrentValue=All&sortBy=PURCHASE_DATE.dsc&pageSize=20&page=${pageNumber}`);

            const booksHandle = await page.$$('.adbl-library-content-row');
            for (let bookHandle of booksHandle) {
                const title = await bookHandle.$eval('.bc-text.bc-size-headline3', element => element.textContent);
                const author = await bookHandle.$eval('.bc-text.bc-size-callout', element => element.textContent);
                let url: string;
                try {
                    url = await bookHandle.$eval('.bc-list-item:nth-of-type(1) .bc-link.bc-color-base', element => element.getAttribute('href'));
                }
                catch (e) {
                    console.log('Cannot find url. Moving on.');
                }
                if (!existingTitles.find(book => book.title === title) && url) {
                    bookData.push({
                        title: title.trim(),
                        author: author.trim(),
                        url: url,
                        owner: owner
                    });
                }


            }
            pageNumber++;

        }

        console.log('bookData', bookData);
        for (let i = 0; i < bookData.length; i++) {

            const params = {
                TableName: 'audible-libraries',
                Item: {
                    id: uuidv4(),
                    title: bookData[i].title,
                    author: bookData[i].author,
                    url: bookData[i].url,
                    owner: bookData[i].owner
                }
            };
            await documentClient.put(params).promise();
        }

        return bookData;
    } catch (e) {
        const screenshot = await page.screenshot();
        const params = { Bucket: bucket, Key: key, Body: screenshot };
        await s3.putObject(params).promise();
        console.log('something happened See screenshot in s3 bucket', e);

    }
}

async function scanTitles(existingTitles = [], lastEvaluatedKey?: aws.DynamoDB.DocumentClient.Key) {

    const scanParams: aws.DynamoDB.DocumentClient.ScanInput = {
        TableName: 'audible-libraries',
        ProjectionExpression: 'title'
    };
    if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
    }
    const titleResponse = await documentClient.scan(scanParams).promise();
    existingTitles.push(...titleResponse.Items);

    if (titleResponse.LastEvaluatedKey) {
        return await scanTitles(existingTitles, titleResponse.LastEvaluatedKey);
    }

    return existingTitles;
}


async function auth(browser: any, cookie: string) {

    const page = await browser.newPage();
    const cookies: puppeteer.Cookie[] = [
        {
            name: "x-main",
            value: cookie,
            domain: ".audible.com",
            path: '/'

        } as puppeteer.Cookie
    ];

    await page.goto('https://audible.com');

    // Set cookie and then go to library
    await page.setCookie(...cookies);
    const libraryUrl = 'https://audible.com/library/titles';
    await page.goto(libraryUrl);
    return page;
}