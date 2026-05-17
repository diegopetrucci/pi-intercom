import type { Component } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { SessionInfo, Message } from "../types.js";

const COLLAPSED_PREVIEW_LINES = 2;
const COLLAPSED_REPLY_PREVIEW_LINES = 4;
const COLLAPSED_SUBAGENT_RESULT_PREVIEW_LINES = 4;
const COLLAPSED_EXPAND_HINT = "Ctrl+O / app.tools.expand";
const SUBAGENT_RESULT_HEADING_PATTERN = /^subagent results?$/i;
const SUBAGENT_RESULT_PREVIEW_FIELDS = ["Run:", "Status:", "Children:"];

export class InlineMessageComponent implements Component {
  private from: SessionInfo;
  private message: Message;
  private theme: Theme;
  private replyCommand?: string;
  private bodyText?: string;
  private expanded: boolean;

  constructor(
    from: SessionInfo,
    message: Message,
    theme: Theme,
    replyCommand?: string,
    bodyText?: string,
    expanded = false,
  ) {
    this.from = from;
    this.message = message;
    this.theme = theme;
    this.replyCommand = replyCommand;
    this.bodyText = bodyText;
    this.expanded = expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 3) {
      return [truncateToWidth(`From ${this.from.name || this.from.id.slice(0, 8)}`, width)];
    }

    const bodyWidth = Math.max(1, width - 2);
    return this.expanded ? this.renderExpanded(bodyWidth) : this.renderCollapsed(bodyWidth);
  }

  private renderExpanded(bodyWidth: number): string[] {
    const lines: string[] = [];
    this.addHeader(lines, bodyWidth);

    const contentLines = wrapTextWithAnsi(this.getBodyText(), bodyWidth);
    for (const line of contentLines) {
      this.addBoxLine(lines, line, bodyWidth);
    }

    if (this.replyCommand) {
      this.addBlankBoxLine(lines, bodyWidth);
      const replyLines = wrapTextWithAnsi(this.theme.fg("dim", ` ↩ To reply: ${this.replyCommand}`), bodyWidth);
      for (const line of replyLines) {
        this.addBoxLine(lines, line, bodyWidth);
      }
    }

    if (this.message.content.attachments?.length) {
      this.addBlankBoxLine(lines, bodyWidth);
      for (const att of this.message.content.attachments) {
        const label = this.theme.fg("dim", ` 📎 ${att.name}`);
        this.addBoxLine(lines, label, bodyWidth);
      }
    }

    if (this.message.replyTo && !this.message.expectsReply) {
      this.addBlankBoxLine(lines, bodyWidth);
      const reply = this.theme.fg("dim", ` ↳ Reply to ${this.message.replyTo.slice(0, 8)}`);
      this.addBoxLine(lines, reply, bodyWidth);
    }

    this.addFooter(lines, bodyWidth);
    return lines;
  }

  private renderCollapsed(bodyWidth: number): string[] {
    const lines: string[] = [];
    this.addHeader(lines, bodyWidth);

    const contentLines = wrapTextWithAnsi(this.getBodyText(), bodyWidth);
    const meaningfulContentLines = contentLines.filter((line) => line.trim().length > 0);
    const previewLines = this.selectCollapsedPreviewLines(meaningfulContentLines);
    for (const line of previewLines) {
      this.addBoxLine(lines, line, bodyWidth);
    }

    const hiddenLineCount = Math.max(0, meaningfulContentLines.length - previewLines.length);
    if (hiddenLineCount > 0) {
      const lineWord = hiddenLineCount === 1 ? "line" : "lines";
      this.addWrappedBoxLines(
        lines,
        this.theme.fg("dim", ` … ${hiddenLineCount} more ${lineWord}; ${this.expandHintText()}`),
        bodyWidth,
      );
    } else {
      this.addWrappedBoxLines(lines, this.theme.fg("dim", ` ↕ ${this.expandHintText()}`), bodyWidth);
    }

    if (this.hasReplyRequest()) {
      const replyText = this.replyCommand
        ? ` ↩ Reply needed: ${this.replyCommand}`
        : " ↩ Reply requested";
      this.addWrappedBoxLines(lines, this.theme.fg("dim", replyText), bodyWidth);
    }

    this.addCollapsedAttachments(lines, bodyWidth);

    if (this.message.replyTo && !this.message.expectsReply) {
      const reply = this.theme.fg("dim", ` ↳ Reply to ${this.message.replyTo.slice(0, 8)}`);
      this.addBoxLine(lines, reply, bodyWidth);
    }

    this.addFooter(lines, bodyWidth);
    return lines;
  }

  private getBodyText(): string {
    return this.bodyText || this.message.content.text;
  }

  private hasReplyRequest(): boolean {
    return Boolean(this.replyCommand || this.message.expectsReply);
  }

  private expandHintText(): string {
    return `${COLLAPSED_EXPAND_HINT} to ${this.hasReplyRequest() ? "read full request" : "expand"}`;
  }

  private selectCollapsedPreviewLines(contentLines: string[]): string[] {
    const subagentResultPreviewLines = this.selectSubagentResultPreviewLines(contentLines);
    if (subagentResultPreviewLines) return subagentResultPreviewLines;

    const previewLineLimit = this.hasReplyRequest() ? COLLAPSED_REPLY_PREVIEW_LINES : COLLAPSED_PREVIEW_LINES;
    return contentLines.slice(0, previewLineLimit);
  }

  private selectSubagentResultPreviewLines(contentLines: string[]): string[] | undefined {
    const heading = contentLines[0]?.trim();
    if (!heading || !SUBAGENT_RESULT_HEADING_PATTERN.test(heading)) return undefined;

    const previewLines = [contentLines[0]];
    for (const field of SUBAGENT_RESULT_PREVIEW_FIELDS) {
      const fieldLine = contentLines.find((line, index) => {
        if (index === 0) return false;
        return line.trim().toLowerCase().startsWith(field.toLowerCase());
      });
      if (fieldLine) previewLines.push(fieldLine);
      if (previewLines.length >= COLLAPSED_SUBAGENT_RESULT_PREVIEW_LINES) break;
    }

    return previewLines;
  }

  private addHeader(lines: string[], bodyWidth: number): void {
    const borderChar = "─";
    const senderName = this.from.name || this.from.id.slice(0, 8);
    const header = ` 📨 From: ${senderName} (${this.from.cwd}) `;
    const headerText = truncateToWidth(header, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    lines.push(this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`));
  }

  private addFooter(lines: string[], bodyWidth: number): void {
    const borderChar = "─";
    lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
  }

  private addBlankBoxLine(lines: string[], bodyWidth: number): void {
    this.addBoxLine(lines, "", bodyWidth);
  }

  private addWrappedBoxLines(lines: string[], text: string, bodyWidth: number): void {
    const wrappedLines = wrapTextWithAnsi(text, bodyWidth);
    for (const line of wrappedLines) {
      this.addBoxLine(lines, line, bodyWidth);
    }
  }

  private addBoxLine(lines: string[], content: string, bodyWidth: number): void {
    const text = truncateToWidth(content, bodyWidth, "");
    const padding = Math.max(0, bodyWidth - visibleWidth(text));
    lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
  }

  private addCollapsedAttachments(lines: string[], bodyWidth: number): void {
    const attachments = this.message.content.attachments;
    if (!attachments?.length) return;

    const visibleAttachments = attachments.slice(0, 2).map((att) => att.name);
    const hiddenAttachmentCount = attachments.length - visibleAttachments.length;
    const suffix = hiddenAttachmentCount > 0 ? `, +${hiddenAttachmentCount} more` : "";
    const attachmentWord = attachments.length === 1 ? "attachment" : "attachments";
    this.addWrappedBoxLines(
      lines,
      this.theme.fg("dim", ` 📎 ${attachments.length} ${attachmentWord}: ${visibleAttachments.join(", ")}${suffix}`),
      bodyWidth,
    );
  }
}
