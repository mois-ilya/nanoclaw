import type { InlineKeyboardMarkup, InputRichBlock, RichMessageButton } from '../botapi/types.js';

export interface ButtonSpec {
  text: string;
  callbackData: string;
}

/** richmessagebutton.md / inlinekeyboardbutton.md: callback_data is 1-64 bytes. */
function checkCallbackData(data: string): void {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes < 1 || bytes > 64) throw new Error(`callback_data must be 1-64 bytes, got ${bytes}`);
}

/** InputRichBlockButtons: 1-8 buttons per row-block. */
const MAX_BUTTONS_PER_ROW = 8;

/**
 * Host-generated buttons as `buttons` blocks (one block per row), placed
 * inside a rich message. The docs support this (inputrichblockbuttons.md), so
 * this is the primary path; the agent's Markdown can never create these
 * because renderMarkdown only emits blocks it builds itself.
 */
export function buttonsBlock(rows: ButtonSpec[][]): InputRichBlock[] {
  const out: InputRichBlock[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i += MAX_BUTTONS_PER_ROW) {
      const buttons: RichMessageButton[] = row.slice(i, i + MAX_BUTTONS_PER_ROW).map((b) => {
        checkCallbackData(b.callbackData);
        return { text: b.text, callback_data: b.callbackData };
      });
      if (buttons.length) out.push({ type: 'buttons', buttons });
    }
  }
  return out;
}

/**
 * Alternative: classic inline keyboard for the `reply_markup` parameter of
 * sendRichMessage / editMessageText (both accept it per the docs).
 */
export function replyMarkup(rows: ButtonSpec[][]): InlineKeyboardMarkup {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => {
        checkCallbackData(b.callbackData);
        return { text: b.text, callback_data: b.callbackData };
      }),
    ),
  };
}
