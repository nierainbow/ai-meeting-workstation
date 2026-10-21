import { useCallback, useEffect, useState } from "react";
import { getVoiceprintGallery, voiceprintGalleryAction, type VoiceprintGalleryEntry } from "./api";

/** T2.4 声纹库管理页：列表 + 改名/合并/删除（sidecar 未启用时整段隐藏）。 */
export function VoiceprintGallerySection() {
  const [voices, setVoices] = useState<VoiceprintGalleryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const body = await getVoiceprintGallery();
      setVoices(Array.isArray(body.voices) ? body.voices : []);
      setError(null);
    } catch {
      setVoices(null); // 未启用 sidecar：整段不渲染
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  if (voices === null) return null;

  const act = async (action: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await voiceprintGalleryAction(action);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="drawer-section voiceprint-gallery" aria-label="声纹库管理">
      <h3>声纹库（{voices.length}）</h3>
      {error ? <p className="form-error">{error}</p> : null}
      {voices.length === 0 ? <p className="cloud-notice">声纹库为空：确认会议中的说话人后会自动累积。</p> : null}
      {voices.map((voice) => (
        <div className="voiceprint-voice" key={String(voice.name)}>
          <span>{String(voice.name)}</span>
          {typeof voice.samples === "number" ? <span className="voiceprint-count">{voice.samples} 样本</span> : null}
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() => {
              const next = window.prompt(`把「${voice.name}」改名为：`, String(voice.name));
              if (next && next !== voice.name) void act({ action: "rename", old: voice.name, new: next });
            }}
          >
            改名
          </button>
          <button
            type="button"
            className="quiet-button"
            disabled={busy}
            onClick={() => {
              const dst = window.prompt(`把「${voice.name}」合并进（目标姓名）：`);
              if (dst) void act({ action: "merge", src: voice.name, dst });
            }}
          >
            合并
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`确定从声纹库删除「${voice.name}」？`)) void act({ action: "delete", name: voice.name });
            }}
          >
            删除
          </button>
        </div>
      ))}
    </section>
  );
}
