// Onboarding: "Talk to your agents". What voice does, and the model choice with its sizes up front (the recommended one
// marked): Download (it keeps going in the background, and Settings > Voice shows it), "Use an existing file…", or Skip,
// which leaves voice off until it's set up in Settings. Nothing downloads without the click; the microphone is asked
// for only at first use, not here.

import { ModelPicker } from "../voice/ModelPicker";
import { useVoicePrefs } from "../../lib/voice/prefs";


export function VoiceStep() {
  const p = useVoicePrefs();
  return (
    <div className="flex flex-col gap-3" data-onboarding-voice>
      <p className="text-base text-dim">
        Hold <span className="font-medium text-fg">Right ⌥</span> in any composer and speak. Pick a model to download; the recommended one translates well and is about half a gigabyte.
      </p>
      <ModelPicker compact />
      <p className="text-small text-faint">
        {p.model ? "Ready. You can change the model and keys in Settings > Voice." : "You can keep going while it downloads. Skip to leave voice off for now."}
      </p>
    </div>
  );
}
