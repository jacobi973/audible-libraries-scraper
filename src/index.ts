import puppeteer, { Browser, Page } from 'puppeteer';
import chromium from 'chrome-aws-lambda';
import aws, { DynamoDB } from 'aws-sdk';




const documentClient = new aws.DynamoDB.DocumentClient();
const s3 = new aws.S3();
const bucket = "screenshot-audible";
const key = "audible.png";

const { v4: uuidv4 } = require('uuid');
const { addExtra } = require('puppeteer-extra');
const pluginStealth = require('puppeteer-extra-plugin-stealth');

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}

exports.handler = async (event) => {
    const args = [
        // '--proxy-server=zproxy.lum-superproxy.io:22225'
    ];

    args.push(...chromium.args);
    const browser = await chromium.puppeteer.launch({
        args: args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath,
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });
    try {
        const bookDetails = await getBookDetails(browser);
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

async function getBookDetails(browser) {
    const url = 'https://www.audible.com/';
    const context = await browser.createIncognitoBrowserContext();
    const page = await auth(context, process.env.jordanCookie);
    try {
        // await page.goto(url);
        // await page.click('.ui-it-sign-in-link');
        // await page.waitForSelector('#ap_email', { timeout: 5000 });
        // await page.type('#ap_email', process.env.email);
        // await page.type('#ap_password', process.env.password);

        // await page.click('#signInSubmit');

        // console.log("Sign in link");
        // console.log("before titles page");
        // await page.waitForSelector('.bc-pub-block.ui-it-header-logo', { timeout: 5000 });

        console.log("after titles page");
        const pageNumberLast: number = +await page.$eval('.linkListWrapper li:nth-last-of-type(2) .bc-link', element => element.getAttribute('data-value'));
        console.log('page number', pageNumberLast);
        // const pageNumber: number = +pageNumberString;
        let pageNumber: number = 1;
        // let libraryHasBooks = true;
        const bookData: any[] = [];
        while (pageNumber <= pageNumberLast) {
            await page.goto(`${url}/library/titles?ref=a_library_t_c6_pageSize_0&pf_rd_p=754864b9-4c5c-4301-b92a-69b12a5623c4&pf_rd_r=2793CX9HNJGABE75EYEX&piltersCurrentValue=All&sortBy=PURCHASE_DATE.dsc&pageSize=20&page=${pageNumber}`);

            const booksHandle = await page.$$('.adbl-library-content-row');
            for (let bookHandle of booksHandle) {
                const title = await bookHandle.$eval('.bc-text.bc-size-headline3', element => element.textContent);
                const author = await bookHandle.$eval('.bc-text.bc-size-callout', element => element.textContent);
                const image = await bookHandle.$eval('img', element => element.getAttribute('src'));
                let url: string;
                try {
                    url = await bookHandle.$eval('.bc-list-item:nth-of-type(1) .bc-link.bc-color-base', element => element.getAttribute('href'));
                }
                catch (e) {
                    console.log('Cannot find url. Moving on.');
                }
                bookData.push({
                    title: title.trim(),
                    author: author.trim(),
                    image: image,
                    url: url,
                });
            }
            pageNumber++;

        }

        console.log('bookData', bookData);
        // const inputParams: aws.DynamoDB.DocumentClient.PutItemInput = {
        //     Item: bookData,
        //     TableName: 'audible-libraries'
        // };
        const params = {
            TableName: 'audible-libraries',
            Item: {
                id: uuidv4(),
                title: bookData[0].title,
                author: bookData[0].author,

            }
        };
        await documentClient.put(params).promise();
        await context.close();

        return bookData;
    } catch (e) {
        const screenshot = await page.screenshot();
        const params = { Bucket: bucket, Key: key, Body: screenshot };
        await s3.putObject(params).promise();
        console.log('something happened See screenshot in s3 bucket', e);
        await context.close();
    }


}

// async function auth(context: any, cookie: string) {

//     const page = await context.newPage();

//     const cookies: puppeteer.Cookie[] = [
//         {
//             name: "x-main",
//             value: cookie,
//             domain: ".audible.com",
//             path: '/'

//         } as puppeteer.Cookie
//     ];

//     await page.goto('https://audible.com');
//     // Set cookie and then go to library
//     await page.setCookie(...cookies);
//     await page.goto('https://audible.com/library/titles');
//     await page.waitForSelector('.post_view').catch((err) => console.log('Unable to get a post_view element'));
//     const screenshot = await page.screenshot();
//     const params = { Bucket: 'audible', Key: 'a1udible.png', Body: screenshot };
//     await s3.putObject(params).promise();
//     try {
//         await page.waitForSelector('.adbl-library-content-row', { timeout: 9000 });
//     } catch (e) {
//         await page.goto('https://audible.com/library/titles');
//         return page;
//     }

//     return page;
// }

async function auth(browser: any, cookie: string) {

    const page = await browser.newPage();
    // await page.authenticate({
    //     username: process.env.luminatiUsername,
    //     password: process.env.luminatiPassword
    // });

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