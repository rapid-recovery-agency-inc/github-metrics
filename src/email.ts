import {
    SendEmailCommand,
    SendEmailCommandInput,
    SendEmailCommandOutput,
    SendRawEmailCommand,
    SendRawEmailCommandInput,
    SendRawEmailCommandOutput,
    SESClient
} from '@aws-sdk/client-ses';
import lodash from 'lodash';
import fs from 'fs/promises';
// @ts-ignore
import mimemessage from 'mimemessage';
import {env} from "./environment.js";

export interface User {
    email: string;
}

export interface Attachment {
    filename: string;
    path: string;
}

interface AttachmentBody {
    filename: string;
    body: string;
}

export interface SendTemplateEmailInput {
    users: User[];
    subject: string;
    attachments: Attachment[];
    body: string;
}

export const sendTemplateEmail = async (
    input: SendTemplateEmailInput,
): Promise<void> => {
    const client = new SESClient({
        region: env().AWS_REGION || 'us-east-2',
    });

    const {users, subject, body, attachments} = input;
    const emails = users.map((user) => user.email as string);
    const emailsChunks: string[][] = lodash.chunk(emails, 45);
    // Attachment processing
    console.log(`📎 Processing ${attachments.length} attachments...`);
    const attachmentBodies: AttachmentBody[] = await Promise.all(
        attachments.map(async (attachment) => {
            console.log(`📄 Reading file: ${attachment.path}`);
            const fileContent = await fs.readFile(attachment.path, {encoding: 'base64'});
            const fileSizeKB = Math.round(fileContent.length * 0.75 / 1024); // Approximate size after base64
            console.log(`✅ File read successfully: ${attachment.filename} (${fileSizeKB}KB)`);
            return {filename: attachment.filename, body: fileContent};
        }),
    );
    console.log(`📎 All attachments processed successfully`);
    const promises: Promise<unknown>[] = [];
    emailsChunks.forEach((emailsChunk) => {
        if (attachmentBodies && attachmentBodies.length > 0) {
            const emailContent = mimemessage.factory({contentType: 'multipart/mixed', body: []});
            emailContent.header('From', env().EMAIL_REPLY_ADDRESS);
            emailContent.header('To', emailsChunk.join(', '));
            emailContent.header('Subject', subject);

            const alternateEntity = mimemessage.factory({
                contentType: 'multipart/alternate',
                body: [],
            });
            const htmlEntity = mimemessage.factory({
                contentType: 'text/html;charset=utf-8',
                body: body,
            });
            const plainEntity = mimemessage.factory({
                body: 'This email requires an HTML reader',
            });

            alternateEntity.body.push(htmlEntity);
            alternateEntity.body.push(plainEntity);
            emailContent.body.push(alternateEntity);

            // Attach the files
            for (const attachmentBody of attachmentBodies) {
                // Determine content type based on file extension
                let contentType = 'application/octet-stream'; // Default
                if (attachmentBody.filename.endsWith('.xlsx')) {
                    contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
                } else if (attachmentBody.filename.endsWith('.xls')) {
                    contentType = 'application/vnd.ms-excel';
                } else if (attachmentBody.filename.endsWith('.pdf')) {
                    contentType = 'application/pdf';
                }
                
                const attachmentEntity = mimemessage.factory({
                    contentType: contentType,
                    contentTransferEncoding: 'base64',
                    body: attachmentBody.body,
                });
                attachmentEntity.header('Content-Disposition', 'attachment; filename="' + attachmentBody.filename + '"');
                emailContent.body.push(attachmentEntity);
            }
            const sendEmailInput: SendRawEmailCommandInput = {
                Source: env().EMAIL_REPLY_ADDRESS,
                Destinations: emailsChunk,
                RawMessage: {
                    Data: new Uint8Array(Buffer.from(emailContent.toString())),
                },
            };
            promises.push(
                client.send<SendRawEmailCommandInput, SendRawEmailCommandOutput>(new SendRawEmailCommand(sendEmailInput)),
            );
        } else {
            // No attachments
            const sendEmailInput: SendEmailCommandInput = {
                Destination: {
                    ToAddresses: emailsChunk,
                },
                Source: env().EMAIL_REPLY_ADDRESS,
                Message: {
                    Subject: {
                        Charset: 'UTF-8',
                        Data: subject,
                    },
                    Body: {
                        Html: {
                            Charset: 'UTF-8',
                            Data: body,
                        },
                    },
                },
            };

            promises.push(
                client.send<SendEmailCommandInput, SendEmailCommandOutput>(new SendEmailCommand(sendEmailInput)),
            );
        }
    });

    await Promise.all(promises);
};
