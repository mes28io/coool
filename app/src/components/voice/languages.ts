// The languages Settings > Voice offers (whisper codes), shared with the recording surface's direction line.

import type { Option } from "../settings/ui";

export const LANGUAGES: Option<string>[] = [
  { value: "auto", label: "Detect automatically" },
  ...(
    [
      ["en", "English"],
      ["tr", "Turkish"],
      ["de", "German"],
      ["es", "Spanish"],
      ["fr", "French"],
      ["it", "Italian"],
      ["pt", "Portuguese"],
      ["nl", "Dutch"],
      ["pl", "Polish"],
      ["ru", "Russian"],
      ["uk", "Ukrainian"],
      ["ar", "Arabic"],
      ["fa", "Persian"],
      ["hi", "Hindi"],
      ["zh", "Chinese"],
      ["ja", "Japanese"],
      ["ko", "Korean"],
      ["sv", "Swedish"],
      ["el", "Greek"],
      ["he", "Hebrew"],
    ] as const
  ).map(([value, label]) => ({ value, label })),
];
