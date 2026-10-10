/** Agent add_reaction names -> Telegram's allowed reaction emoji (§3.6). */

const ALLOWED_RAW =
  '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡';

const strip = (s: string) => s.replace(/️/g, '');
const ALLOWED = new Set(ALLOWED_RAW.split(' ').map(strip));

const NAMES: Record<string, string> = {
  thumbs_up: '👍',
  thumbsup: '👍',
  '+1': '👍',
  like: '👍',
  thumbs_down: '👎',
  thumbsdown: '👎',
  '-1': '👎',
  heart: '❤',
  red_heart: '❤',
  love: '❤',
  ok_hand: '👌',
  ok: '👌',
  eyes: '👀',
  fire: '🔥',
  check: '👍',
  white_check_mark: '👍',
  heavy_check_mark: '👍',
  done: '👍',
  clap: '👏',
  pray: '🙏',
  thanks: '🙏',
  tada: '🎉',
  party: '🎉',
  hundred: '💯',
  '100': '💯',
  smile: '😁',
  grin: '😁',
  laugh: '🤣',
  joy: '🤣',
  thinking: '🤔',
  thinking_face: '🤔',
  cool: '😎',
  sunglasses: '😎',
  rocket: '⚡',
  zap: '⚡',
  handshake: '🤝',
  salute: '🫡',
  writing_hand: '✍',
  sob: '😭',
  cry: '😢',
};

/** Name, shortcode (":fire:") or literal emoji -> an emoji Telegram accepts; 👍 when nothing matches. */
export function mapReaction(raw: string): string {
  const s = raw.trim();
  const lit = strip(s);
  if (ALLOWED.has(lit)) return lit;
  const key = s
    .toLowerCase()
    .replace(/^:|:$/g, '')
    .replace(/[\s-]+/g, '_');
  return NAMES[key] ?? '👍';
}
