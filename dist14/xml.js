"use strict";
/**
 * Minimal, dependency-free XML slicing helpers.
 *
 * DIADesigner PLCopen exports must survive a round trip untouched outside the
 * region we edit, so we never re-serialize the document: we locate byte ranges
 * and splice strings. That keeps unknown Delta-specific elements, attribute
 * order, CDATA payloads and original formatting intact.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IDENTIFIER_RE = void 0;
exports.detectNewline = detectNewline;
exports.normalizeNewlines = normalizeNewlines;
exports.xmlEscapeAttribute = xmlEscapeAttribute;
exports.xmlUnescapeAttribute = xmlUnescapeAttribute;
exports.cdata = cdata;
exports.validateIdentifier = validateIdentifier;
exports.nextXmlTag = nextXmlTag;
exports.parseAttributes = parseAttributes;
exports.findElementRange = findElementRange;
exports.findDirectChildRange = findDirectChildRange;
exports.findDirectChildren = findDirectChildren;
exports.indentOfLine = indentOfLine;
exports.indentBlock = indentBlock;
exports.replaceRange = replaceRange;
exports.spliceIndentedBlock = spliceIndentedBlock;
exports.insertAsLastChild = insertAsLastChild;
exports.ensureChildContainer = ensureChildContainer;
exports.innerXml = innerXml;
exports.IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function detectNewline(value) {
    return value.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
}
function normalizeNewlines(value, newline) {
    return value.replace(/\r\n|\r|\n/g, newline);
}
function xmlEscapeAttribute(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}
function xmlUnescapeAttribute(value) {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}
/** Escapes a `]]>` sequence so arbitrary text can live inside a CDATA block. */
function cdata(value) {
    return value.replace(/\]\]>/g, "]]]]><![CDATA[>");
}
function validateIdentifier(name, label) {
    if (!exports.IDENTIFIER_RE.test(name)) {
        throw new Error(`${label} must be a valid IEC identifier: ${name}`);
    }
}
function findTagEnd(xml, start) {
    let quote = null;
    for (let index = start + 1; index < xml.length; index++) {
        const char = xml[index];
        if (quote) {
            if (char === quote)
                quote = null;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === ">")
            return index;
    }
    throw new Error(`Unterminated XML tag at offset ${start}`);
}
/** Finds the next real element tag, skipping CDATA, comments, PIs and doctypes. */
function nextXmlTag(xml, fromIndex) {
    let start = xml.indexOf("<", fromIndex);
    while (start >= 0) {
        if (xml.startsWith("<![CDATA[", start)) {
            const end = xml.indexOf("]]>", start + 9);
            if (end < 0)
                throw new Error(`Unterminated CDATA section at offset ${start}`);
            start = xml.indexOf("<", end + 3);
            continue;
        }
        if (xml.startsWith("<!--", start)) {
            const end = xml.indexOf("-->", start + 4);
            if (end < 0)
                throw new Error(`Unterminated XML comment at offset ${start}`);
            start = xml.indexOf("<", end + 3);
            continue;
        }
        if (xml.startsWith("<?", start)) {
            const end = xml.indexOf("?>", start + 2);
            if (end < 0)
                throw new Error(`Unterminated XML processing instruction at offset ${start}`);
            start = xml.indexOf("<", end + 2);
            continue;
        }
        if (xml.startsWith("<!", start)) {
            const end = findTagEnd(xml, start);
            start = xml.indexOf("<", end + 1);
            continue;
        }
        const end = findTagEnd(xml, start);
        const raw = xml.slice(start, end + 1);
        let content = raw.slice(1, -1).trim();
        const closing = content.startsWith("/");
        if (closing)
            content = content.slice(1).trim();
        const selfClosing = !closing && /\/\s*$/.test(content);
        if (selfClosing)
            content = content.replace(/\/\s*$/, "").trim();
        const nameMatch = /^([^\s/>]+)/.exec(content);
        if (!nameMatch) {
            start = xml.indexOf("<", end + 1);
            continue;
        }
        return { start, end, name: nameMatch[1], raw, closing, selfClosing };
    }
    return null;
}
function parseAttributes(openTag) {
    let content = openTag.slice(1, -1).trim();
    if (content.startsWith("/"))
        content = content.slice(1).trim();
    content = content.replace(/\/\s*$/, "");
    const attributes = {};
    const re = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match;
    while ((match = re.exec(content)) !== null) {
        attributes[match[1]] = xmlUnescapeAttribute(match[2] ?? match[3] ?? "");
    }
    return attributes;
}
function findElementRange(xml, tagName, fromIndex = 0, predicate) {
    let searchFrom = fromIndex;
    let tag;
    while ((tag = nextXmlTag(xml, searchFrom)) !== null) {
        searchFrom = tag.end + 1;
        if (tag.closing || tag.name !== tagName)
            continue;
        if (predicate && !predicate(tag))
            continue;
        if (tag.selfClosing) {
            return {
                start: tag.start,
                openEnd: tag.end + 1,
                closeStart: tag.start,
                end: tag.end + 1,
                openTag: tag.raw,
                selfClosing: true
            };
        }
        let depth = 1;
        let innerFrom = tag.end + 1;
        let inner;
        while ((inner = nextXmlTag(xml, innerFrom)) !== null) {
            innerFrom = inner.end + 1;
            if (inner.name !== tagName)
                continue;
            if (!inner.closing && !inner.selfClosing) {
                depth++;
                continue;
            }
            if (inner.closing) {
                depth--;
                if (depth === 0) {
                    return {
                        start: tag.start,
                        openEnd: tag.end + 1,
                        closeStart: inner.start,
                        end: inner.end + 1,
                        openTag: tag.raw,
                        selfClosing: false
                    };
                }
            }
        }
        throw new Error(`Missing closing </${tagName}> tag`);
    }
    return null;
}
function findDirectChildRange(xml, parent, tagName) {
    const child = findElementRange(xml, tagName, parent.openEnd);
    if (!child || child.start >= parent.closeStart)
        return null;
    return child;
}
/** Returns every direct child element with the given tag name. */
function findDirectChildren(xml, parent, tagName) {
    const found = [];
    let from = parent.openEnd;
    while (from < parent.closeStart) {
        const child = findElementRange(xml, tagName, from);
        if (!child || child.start >= parent.closeStart)
            break;
        found.push(child);
        from = child.end;
    }
    return found;
}
function indentOfLine(xml, index) {
    const lineStart = Math.max(xml.lastIndexOf("\n", index - 1), xml.lastIndexOf("\r", index - 1)) + 1;
    const match = /^[ \t]*/.exec(xml.slice(lineStart, index));
    return match ? match[0] : "";
}
/**
 * Prefixes every line with `indent`, except lines that continue an open CDATA
 * section — indenting those would change the literal ST source inside them.
 */
function indentBlock(block, indent, newline) {
    let inCdata = false;
    return normalizeNewlines(block.trim(), newline)
        .split(newline)
        .map((line) => {
        const prefix = inCdata ? "" : indent;
        let index = 0;
        while (index < line.length) {
            if (inCdata) {
                const end = line.indexOf("]]>", index);
                if (end < 0)
                    break;
                inCdata = false;
                index = end + 3;
                continue;
            }
            const start = line.indexOf("<![CDATA[", index);
            if (start < 0)
                break;
            inCdata = true;
            index = start + 9;
        }
        return `${prefix}${line}`;
    })
        .join(newline);
}
function replaceRange(xml, start, end, replacement) {
    return xml.slice(0, start) + replacement + xml.slice(end);
}
/** Start of the whitespace run that indents the line containing `index`. */
function lineIndentStart(xml, index) {
    return index - indentOfLine(xml, index).length;
}
/**
 * Splices an indented block over `[start, end)`.
 *
 * The range is widened backwards over the leading whitespace of its own line so
 * the block's own indentation is the only one applied. Inserting at `start`
 * directly would stack the existing indent on top of `indent`, which is how the
 * 1.13 editor produced progressively skewed exports.
 */
function spliceIndentedBlock(xml, start, end, block, indent, newline) {
    const from = lineIndentStart(xml, start);
    return replaceRange(xml, from, end, indentBlock(block, indent, newline));
}
/**
 * Inserts an indented block as the last child of `container`, keeping the
 * closing tag on its own correctly indented line.
 */
function insertAsLastChild(xml, container, block, newline) {
    const closeIndent = indentOfLine(xml, container.closeStart);
    const childIndent = `${closeIndent}  `;
    const from = lineIndentStart(xml, container.closeStart);
    const rendered = indentBlock(block, childIndent, newline);
    return replaceRange(xml, from, container.closeStart, `${rendered}${newline}${closeIndent}`);
}
/**
 * Ensures `<parent><child>` exists, creating an empty `<child>` when missing.
 * Returns the (possibly rewritten) document plus the child's range.
 */
function ensureChildContainer(xml, parentTagName, childTagName, newline) {
    const parent = findElementRange(xml, parentTagName);
    if (!parent)
        throw new Error(`Missing <${parentTagName}> element`);
    const existing = findDirectChildRange(xml, parent, childTagName);
    if (existing)
        return { xml, range: existing };
    const closeIndent = indentOfLine(xml, parent.closeStart);
    const childIndent = `${closeIndent}  `;
    const from = lineIndentStart(xml, parent.closeStart);
    const block = `${childIndent}<${childTagName}>${newline}${childIndent}</${childTagName}>`;
    const next = replaceRange(xml, from, parent.closeStart, `${block}${newline}${closeIndent}`);
    const newParent = findElementRange(next, parentTagName);
    if (!newParent)
        throw new Error(`Missing <${parentTagName}> element after insert`);
    const created = findDirectChildRange(next, newParent, childTagName);
    if (!created)
        throw new Error(`Failed to create <${childTagName}> container`);
    return { xml: next, range: created };
}
/** Text content of an element range, with the surrounding tags removed. */
function innerXml(xml, range) {
    if (range.selfClosing)
        return "";
    return xml.slice(range.openEnd, range.closeStart);
}
