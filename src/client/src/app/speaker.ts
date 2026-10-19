export function speakerLetter(speakerLabel: string): string {
  const match = speakerLabel.match(/(\d+)(?!.*\d)/);
  if (!match) return speakerLabel.trim().slice(0, 1).toUpperCase() || "?";
  let value = Number(match[1]) + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function speakerTone(speakerLabel: string): number {
  const match = speakerLabel.match(/(\d+)(?!.*\d)/);
  if (match) return Number(match[1]) % 8;
  return Array.from(speakerLabel).reduce((total, character) => total + character.charCodeAt(0), 0) % 8;
}
