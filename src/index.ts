import puppeteer, { Browser, Page } from 'puppeteer';
import chromium from 'chrome-aws-lambda';
import aws from 'aws-sdk';

const documentClient = new aws.DynamoDB.DocumentClient();
const cognitoIdentityServiceProvider = new aws.CognitoIdentityServiceProvider();
const s3 = new aws.S3();
const ses = new aws.SES({ region: 'us-east-2' });
const bucket = "screenshot-audible";
const key = "audible.png";
const { v4: uuidv4 } = require('uuid');

exports.handler = async () => {
    try {
        await getBookDetails();
    } catch (e) {
        const screenshot = await e.page.screenshot();
        const params = { Bucket: bucket, Key: key, Body: screenshot };
        await s3.putObject(params).promise();
        console.log('something happened See screenshot in s3 bucket', e.error);
        return e.error;
    }

}


async function getBookDetails() {
    const cookies = [
        process.env.jordanCookie,
        process.env.jonCookie,
        process.env.ashliCookie,
        process.env.chrisCookie
    ];
    const url = 'https://www.audible.com/';
    const args = [];
    args.push(...chromium.args);
    const finalBooks = [];
    try {
        for (let i = 0; i < cookies.length; i++) {
            const bookData = [];
            const browser = await chromium.puppeteer.launch({
                args: args,
                defaultViewport: chromium.defaultViewport,
                executablePath: await chromium.executablePath,
                headless: chromium.headless,
                ignoreHTTPSErrors: true,
            });

            const page = await auth(browser, cookies[i]);
            let pageNumberLast: number;
            try {
                pageNumberLast = +await page.$eval('.linkListWrapper li:nth-last-of-type(2) .bc-link', element => element.innerText);
            } catch (e) {
                pageNumberLast = 2;
            }

            console.log('page number', pageNumberLast);
            let owner = await page.$eval('.bc-text.navigation-do-underline-on-hover.ui-it-barker-text', element => element.textContent);
            owner = owner.split(',')[1].replace('!', '').trim();
            let pageNumber: number = 1;
            const existingBooks = await scanBooks();

            while (pageNumber <= pageNumberLast) {
                await page.goto(`${url}/library/titles?ref=a_library_t_c6_pageSize_0&pf_rd_p=754864b9-4c5c-4301-b92a-69b12a5623c4&pf_rd_r=2793CX9HNJGABE75EYEX&piltersCurrentValue=All&sortBy=PURCHASE_DATE.dsc&pageSize=20&page=${pageNumber}`);

                const booksHandle = await page.$$('.adbl-library-content-row');
                for (let bookHandle of booksHandle) {
                    const title = (await bookHandle.$eval('.bc-text.bc-size-headline3', element => element.textContent)).trim();
                    // for some reason this title repeats in the list, so we need to filter it out
                    if (title === 'The Lost Hero: The Heroes of Olympus, Book One') {
                        continue;
                    }
                    const author = await bookHandle.$eval('.bc-text.bc-size-callout', element => element.textContent);
                    const picture = await bookHandle.$eval('.bc-image-inset-border', element => element.getAttribute('src'));
                    let url: string;
                    try {
                        url = await bookHandle.$eval('.bc-list-item:nth-of-type(1) .bc-link.bc-color-base', element => element.getAttribute('href'));
                    }
                    catch (e) {
                        console.log('Cannot find url. Moving on.');
                        continue;
                    }
                    if (!existingBooks.find(book => book.title === title && book.owner === owner)) {
                        bookData.push({
                            title: title.trim(),
                            author: author.trim(),
                            url: url,
                            owner: owner,
                            image: picture
                        });
                        finalBooks.push({
                            title: title.trim(),
                            author: author.trim(),
                            url: url,
                            owner: owner,
                            image: picture
                        });
                    }
                    else {
                        console.log('duplicate Book found', title, owner);
                    }

                }
                pageNumber++;
            }

            for (let i = 0; i < bookData.length; i++) {
                const params = {
                    TableName: 'audible-libraries',
                    Item: {
                        id: uuidv4(),
                        title: bookData[i].title,
                        author: bookData[i].author,
                        url: bookData[i].url,
                        owner: bookData[i].owner,
                        image: bookData[i].image
                    }
                };
                console.log('insert params', params);
                await documentClient.put(params).promise();
            }

            await browser.close();
        }
        if (finalBooks) {
            await sendEmail(finalBooks);
        }
    }
    catch (e) {
        console.log('something happened See screenshot in s3 bucket', e);
    }
}

async function scanBooks(existingBooks = [], lastEvaluatedKey?: aws.DynamoDB.DocumentClient.Key) {

    const scanParams: aws.DynamoDB.DocumentClient.ScanInput = {
        TableName: 'audible-libraries'
    };
    if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
    }
    const titleResponse = await documentClient.scan(scanParams).promise();
    existingBooks.push(...titleResponse.Items);

    if (titleResponse.LastEvaluatedKey) {
        return await scanBooks(existingBooks, titleResponse.LastEvaluatedKey);
    }

    return existingBooks;
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

async function sendEmail(finalBooks: any[]) {
    const params = {
        UserPoolId: process.env.userPoolId,
        AttributesToGet: ['email'],
        Filter: 'preferred_username = "true"'
    };
    const userEmails = await cognitoIdentityServiceProvider.listUsers(params).promise();
    // push userEmails into an array of emails
    const emails = userEmails.Users.map(user => user.Username);
    let html = htmlHolder();
    for (let i = 0; i < finalBooks.length; i++) {
        if (finalBooks[i].owner !== 'Jordan') {
            html += `
        <tr>
        <td align="center"
            style="font-size:0; padding:0; padding-top:0; padding-right:0; padding-bottom:0; padding-left:0; word-break:break-word">
            <table border="0"
                cellpadding="0"
                cellspacing="0"
                role="presentation"
                class="x_mj-full-width-mobile"
                style="border-collapse:collapse; border-spacing:0">
                <tbody>
                    <tr>
                        <td class="x_mj-full-width-mobile"
                            style="width:292px">
                            <a href="https://audible.com/${finalBooks[i].url} "target="_blank">
                            <img data-imagetype="External"
                                src="${finalBooks[i].image}"
                                alt="Alternate image text"
                                height="auto"
                                width="292"
                                style="border:0 solid #1e293b; border-radius:0; display:block; outline:0; text-decoration:none; height:auto; width:100%; font-size:13px">
                            </a>
                        </td>
                    </tr>
                </tbody>
            </table>
        </td>
    </tr>
    <tr>
        <td align="left"
            style="font-size:0; padding:10px 25px; padding-top:0; padding-right:0; padding-bottom:24px; padding-left:0; word-break:break-word">
            <div
                style="font-family: Helvetica, serif, EmojiFont; font-size: 16px; font-weight: 400; letter-spacing: 0px; line-height: 1.5; text-align: left; color: rgb(30, 41, 59);">
                <p
                    style="text-align:center">
                    ${finalBooks[i].title}</p>
                <p
                    style="text-align:center">
                    ${finalBooks[i].owner}</p>
            </div>
        </td>
    </tr>`
            if ((i + 1) === finalBooks.length) {
                html += htmlHolder(true);
                // send email through SES
                const params: aws.SES.SendEmailRequest = {
                    Destination: {
                        ToAddresses: emails
                    },
                    Message: {
                        Body: {
                            Html: {
                                Data: html
                            },
                        },

                        Subject: { Data: "New Books" },
                    },
                    Source: "jacobsaudibleupdates@gmail.com",
                };

                await ses.sendEmail(params).promise();
            }
        }
    }
}




// Wow thats ugly
function htmlHolder(ending?: boolean) {
    if (ending) {
        return `
        </tbody>
    </table>
</td>
</tr>
</tbody>
</table>
</div>
</td>
</tr>
</tbody>
</table>
</div>
</td>
</tr>
</tbody>
</table>
</div>
</div>
</div>
</div>
</div>
</div>`
    }
    return `
            <div>
            <style type="text/css">
                <!--
                .rps_f7a7 #x_outlook a {
                    padding: 0
                }
        
                .rps_f7a7>div {
                    margin: 0;
                    padding: 0
                }
        
                .rps_f7a7 table,
                .rps_f7a7 td {
                    border-collapse: collapse
                }
        
                .rps_f7a7 img {
                    border: 0;
                    height: auto;
                    line-height: 100%;
                    outline: 0;
                    text-decoration: none
                }
        
                .rps_f7a7 p {
                    display: block;
                    margin: 13px 0
                }
                -->
            </style>
            <style type="text/css">
                <!--
                @media only screen and (min-width:480px) {
                    .rps_f7a7 .x_mj-column-per-100 {
                        width: 100% !important;
                        max-width: 100%
                    }
        
                }
                -->
            </style>
            <style type="text/css">
                <!--
                @media only screen and (max-width:480px) {
                    .rps_f7a7 table.x_mj-full-width-mobile {
                        width: 100% !important
                    }
        
                    .rps_f7a7 td.x_mj-full-width-mobile {
                        width: auto !important
                    }
        
                }
                -->
            </style>
            <style type="text/css">
                <!--
                .rps_f7a7 div p {
                    margin: 0 0
                }
        
                .rps_f7a7 false h1,
                .rps_f7a7 h2,
                .rps_f7a7 h3,
                .rps_f7a7 h4,
                .rps_f7a7 h5,
                .rps_f7a7 h6 {
                    margin: 0
                }
        
                .rps_f7a7 ol {
                    margin-top: 0;
                    margin-bottom: 0
                }
        
                .rps_f7a7 figure.x_table {
                    margin: 0
                }
        
                .rps_f7a7 figure.x_table table {
                    width: 100%
                }
        
                .rps_f7a7 figure.x_table table td,
                .rps_f7a7 figure.x_table table th {
                    min-width: 2em;
                    padding: .4em;
                    border: 1px solid #bfbfbf
                }
        
                .rps_f7a7 .x_hide-on-desktop {
                    display: none
                }
        
                @media only screen and (max-width:480px) {
                    .rps_f7a7 table.x_mj-full-width-mobile {
                        width: 100% !important
                    }
        
                    .rps_f7a7 td.x_mj-full-width-mobile {
                        width: auto !important
                    }
        
                }
                -->
            </style>
            <div class="rps_f7a7">
                <div style="background-color:#f8fafc">
                    <div style="background-color:#f8fafc">
                        <div style="background:#fff; background-color:#fff; margin:0 auto; max-width:600px">
                            <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation"
                                style="background:#fff; background-color:#fff; width:100%">
                                <tbody>
                                    <tr>
                                        <td
                                            style="direction:ltr; font-size:0; padding:0; padding-bottom:0; padding-left:0; padding-right:0; padding-top:0; text-align:center">
                                            <div style="background:#fff; background-color:#fff; margin:0 auto; max-width:600px">
                                                <table align="center" border="0" cellpadding="0" cellspacing="0"
                                                    role="presentation"
                                                    style="background:#fff; background-color:#fff; width:100%">
                                                    <tbody>
                                                        <tr>
                                                            <td
                                                                style="border:0 solid #1e293b; direction:ltr; font-size:0; padding:20px 0; padding-bottom:16px; padding-left:16px; padding-right:16px; padding-top:16px; text-align:center">
                                                                <div class="x_mj-column-per-100 x_mj-outlook-group-fix"
                                                                    style="font-size:0; text-align:left; direction:ltr; display:inline-block; vertical-align:top; width:100%">
                                                                    <table border="0" cellpadding="0" cellspacing="0"
                                                                        role="presentation" width="100%"
                                                                        style="background-color:transparent; border:0 solid transparent; vertical-align:top">
                                                                        <tbody>
                                                                            <tr>
                                                                                <td align="left"
                                                                                    style="font-size:0; padding:10px 25px; padding-top:0; padding-right:0; padding-bottom:24px; padding-left:0; word-break:break-word">
                                                                                    <div
                                                                                        style="font-family: Helvetica, serif, EmojiFont; font-size: 28px; font-weight: 400; letter-spacing: 0px; line-height: 1.5; text-align: left; color: rgb(30, 41, 59);">
                                                                                        <p style="text-align:center">New Books
                                                                                            added!</p>
                                                                                    </div>
                                                                                </td>
                                                                            </tr>
                                                                        </tbody>
                                                                    </table>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </div>
                                            <div style="background:#fff; background-color:#fff; margin:0 auto; max-width:600px">
                                                <table align="center" border="0" cellpadding="0" cellspacing="0"
                                                    role="presentation"
                                                    style="background:#fff; background-color:#fff; width:100%">
                                                    <tbody>
                                                        <tr>
                                                            <td
                                                                style="border:0 solid #1e293b; direction:ltr; font-size:0; padding:20px 0; padding-bottom:10px; padding-left:10px; padding-right:16px; padding-top:10px; text-align:center">
                                                                <div class="x_mj-column-per-100 x_mj-outlook-group-fix"
                                                                    style="font-size:0; text-align:left; direction:ltr; display:inline-block; vertical-align:top; width:100%">
                                                                    <table border="0" cellpadding="0" cellspacing="0"
                                                                        role="presentation" width="100%">
                                                                        <tbody>
                                                                            <tr>
                                                                                <td
                                                                                    style="background-color:transparent; border:0 solid transparent; vertical-align:top; padding-top:0; padding-right:0; padding-bottom:0; padding-left:0">
                                                                                    <table border="0" cellpadding="0"
                                                                                        cellspacing="0" role="presentation"
                                                                                        width="100%">
                                                                                        <tbody>`;
}
