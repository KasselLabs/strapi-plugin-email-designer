'use strict';

const cheerio = require('cheerio');
const _ = require('lodash');
// From: https://stackoverflow.com/questions/201323/how-can-i-validate-an-email-address-using-a-regular-expression
const isValidEmail =
  /(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9]))\.){3}(?:(2(5[0-5]|[0-4][0-9])|1[0-9][0-9]|[1-9]?[0-9])|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])/;

const decode = require('decode-html');
const { htmlToText } = require('html-to-text');
const { isEmpty } = require('lodash');

const { mantainLegacyTemplate = true } = (strapi.plugins['email-designer'] || {}).config || {};

const templateSettings = {
  evaluate: /\{\{(.+?)\}\}/g,
  interpolate: /\{\{=(.+?)\}\}/g,
  escape: /\{\{-(.+?)\}\}/g,
};

const getAllStyleTextsInsideBody = ($) => {
  return $('body style').get().map(el => el.children[0].data).join('\n')
}

const templater = (tmpl, parseStyles) => {
  return (...args) => {
    const parsedTemplateText = _.template(tmpl, templateSettings)(...args)
    if (!parseStyles) {
      return parsedTemplateText
    }

    // Take all styles inside body and add them to <head></head>, or they'll
    // disappear when the email is sent
    const $ = cheerio.load(parsedTemplateText);
    const styleTexts = getAllStyleTextsInsideBody($)
    $('body style').remove()
    $('head style').append(styleTexts)

    return $.html()
  }
};

const EMAIL_OPTIONS_TO_VALIDATE = new Set(['from', 'to', 'cc', 'bcc', 'replyTo']);

/**
 * fill subject, text and html using lodash template
 * @param {object} emailOptions - to, from and replyto...
 * @param {object} emailTemplate - object containing attributes to fill
 * @param {object} data - data used to fill the template
 * @returns {{ subject, text, subject }}
 */
const sendTemplatedEmail = async (emailOptions = {}, emailTemplate = {}, data = {}) => {
  Object.entries(emailOptions).forEach(([key, address]) => {
    // ⬇︎ Thanks to @xcivit 's #39 suggestion
    if (EMAIL_OPTIONS_TO_VALIDATE.has(key)) {
      if (Array.isArray(address)) {
        address.forEach((email) => {
          if (!isValidEmail.test(email)) throw new Error(`Invalid "${key}" email address with value "${email}"`);
        });
      } else {
        if (!isValidEmail.test(address)) throw new Error(`Invalid "${key}" email address with value "${address}"`);
      }
    }
  });

  const requiredAttributes = ['templateId'];
  const attributes = ['text', 'html', 'subject'];
  const missingAttributes = _.difference(requiredAttributes, Object.keys(emailTemplate));
  if (missingAttributes.length > 0) {
    throw new Error(`Following attributes are missing from your email template : ${missingAttributes.join(', ')}`);
  }

  let bodyHtml, bodyText, subject;

  const sourceCodeToTemplateId = emailTemplate.sourceCodeToTemplateId;
  if (sourceCodeToTemplateId) {
    const response = await strapi
      .query('email-template', 'email-designer')
      .findOne({ sourceCodeToTemplateId: sourceCodeToTemplateId });
    ({ bodyHtml, bodyText, subject } = response);
  } else {
    const response = await strapi.query('email-template', 'email-designer').findOne({ id: emailTemplate.templateId });
    ({ bodyHtml, bodyText, subject } = response);
  }

  if (mantainLegacyTemplate) {
    bodyHtml = bodyHtml.replace(/<%/g, '{{').replace(/%>/g, '}}');
    bodyText = bodyText.replace(/<%/g, '{{').replace(/%>/g, '}}');
    subject = subject.replace(/<%/g, '{{').replace(/%>/g, '}}');
  }

  if ((!bodyText || !bodyText.length) && bodyHtml && bodyHtml.length)
    bodyText = htmlToText(bodyHtml, { wordwrap: 130, trimEmptyLines: true, uppercaseHeadings: false });

  emailTemplate = {
    ...emailTemplate,
    subject:
      (!isEmpty(emailTemplate.subject) && emailTemplate.subject) ||
      (!isEmpty(subject) && decode(subject)) ||
      'No Subject',
    html: decode(bodyHtml),
    text: decode(bodyText),
  };

  const templatedAttributes = attributes.reduce(
    (compiled, attribute) =>
      emailTemplate[attribute]
        ? Object.assign(compiled, { [attribute]: templater(emailTemplate[attribute], attribute !== 'subject')(data) })
        : compiled,
    {}
  );

  return strapi.plugins.email.provider.send({ ...emailOptions, ...templatedAttributes });
};

/**
 * @Deprecated
 * Promise to retrieve a composed HTML email.
 * @return {Promise}
 */
const compose = async ({ templateId, data = {} }) => {
  strapi.log.debug(`⚠️: `, `The 'compose' function is deprecated and may be removed or changed in the future.`);
  if (!templateId) throw new Error("No email template's id provided");

  let { bodyHtml, bodyText, subject } = await strapi
    .query('email-template', 'email-designer')
    .findOne({ id: templateId });

  if (mantainLegacyTemplate) {
    bodyHtml = bodyHtml.replace(/<%/g, '{{').replace(/%>/g, '}}');
    bodyText = bodyText.replace(/<%/g, '{{').replace(/%>/g, '}}');
    subject = subject.replace(/<%/g, '{{').replace(/%>/g, '}}');
  }

  if ((!bodyText || !bodyText.length) && bodyHtml && bodyHtml.length)
    bodyText = htmlToText(bodyHtml, { wordwrap: 130, trimEmptyLines: true, uppercaseHeadings: false });

  const emailTemplate = {
    html: decode(bodyHtml),
    text: decode(bodyText),
  };

  const attributes = ['text', 'html'];
  const templatedAttributes = attributes.reduce(
    (compiled, attribute) =>
      emailTemplate[attribute]
        ? Object.assign(compiled, { [attribute]: templater(emailTemplate[attribute], attribute !== 'subject')(data) })
        : compiled,
    {}
  );

  return {
    composedHtml: templatedAttributes.html,
    composedText: templatedAttributes.text,
  };
};

/**
 * @Deprecated
 * Promise to send a composed HTML email.
 * @return {Promise}
 */
const send = async ({ templateId, data, to, from, replyTo, subject }) => {
  strapi.log.debug(`⚠️: `, `The 'send' function is deprecated and may be removed or changed in the future.`);

  Object.entries({ to, from, replyTo }).forEach(([key, address]) => {
    if (!isValidEmail.test(address)) throw new Error(`Invalid "${key}" email address with value "${address}"`);
  });

  try {
    const { composedHtml = '', composedText = '' } = await strapi.plugins['email-designer'].services.email.compose({
      templateId,
      data,
    });

    await strapi.plugins['email'].services.email.send({
      to,
      from,
      replyTo,
      subject,
      html: composedHtml,
      text: composedText,
    });
  } catch (err) {
    strapi.log.debug(`📺: `, err);
    throw new Error(err);
  }
};

module.exports = {
  sendTemplatedEmail,
  compose,
  send,
};
