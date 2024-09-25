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
    const attachmentBodies: AttachmentBody[] = await Promise.all(
        attachments.map(async (attachment) => {
            const fileContent = await fs.readFile(attachment.path, {encoding: 'base64'});
            return {filename: attachment.filename, body: fileContent};
        }),
    );
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
                const attachmentEntity = mimemessage.factory({
                    contentType: 'text/plain',
                    contentTransferEncoding: 'base64',
                    body: attachmentBody.body,
                });
                attachmentEntity.header('Content-Disposition', 'attachment ;filename="' + attachmentBody.filename + '"');
                emailContent.body.push(attachmentEntity);
            }
            const sendEmailInput: SendRawEmailCommandInput = {
                Source: env().EMAIL_REPLY_ADDRESS,
                Destinations: emailsChunk,
                RawMessage: {
                    Data: Buffer.from(emailContent.toString()),
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
