import { useCallback, useEffect, useState } from "react";
import { confirmVoiceprintCluster, listVoiceprintPending, type VoiceprintPendingCluster } from "./api";

/**
 * T2.4 待确认面板：展示声纹识别出的「疑似/待确认」说话人簇，
 * 人工确认（可改名）或跳过。识别结果一律按疑似语义渲染，绝不事实定名。
 */
export function VoiceprintConfirmPanel(props: { discussionId: string; onChanged?: () => void }) {
  const [clusters, setClusters] = useState<VoiceprintPendingCluster[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const body = await listVoiceprintPending(props.discussionId);
      setClusters(body.clusters);
      setError(null);
    } catch {
      // sidecar 未启用/不可用时面板静默为空，不打断主流程。
      setClusters([]);
    }
  }, [props.discussionId]);

  useEffect(() => { void reload(); }, [reload]);

  if (clusters.length === 0) return null;

  const act = async (clusterId: string, name: string | null) => {
    setBusy(clusterId);
    try {
      await confirmVoiceprintCluster({ discussionId: props.discussionId, clusterId: Number(clusterId), name });
      await reload();
      props.onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "确认失败");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="voiceprint-confirm-panel" aria-label="声纹待确认">
      <header className="voiceprint-confirm-header">
        <strong>声纹待确认（{clusters.length}）</strong>
        <button type="button" className="quiet-button" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "展开" : "收起"}
        </button>
      </header>
      {collapsed ? null : (
        <>
          <p className="cloud-notice">以下为声纹自动识别的<strong>疑似</strong>结果，需人工确认后才定名。</p>
          {error ? <p className="form-error">{error}</p> : null}
          {clusters.map((cluster) => (
            <div className="voiceprint-cluster" key={cluster.clusterId}>
              <div className="voiceprint-cluster-head">
                <span className={cluster.identifyStatus === "suspected" ? "tag-suspected" : "tag-pending"}>
                  {cluster.currentLabel}
                </span>
                <span className="voiceprint-count">{cluster.utteranceCount} 段发言</span>
              </div>
              <ul className="voiceprint-samples">
                {cluster.samples.map((s) => <li key={s.id}>{s.text}</li>)}
              </ul>
              <div className="voiceprint-actions">
                <input
                  type="text"
                  placeholder="确认姓名（默认沿用当前名）"
                  value={editing[cluster.clusterId] ?? ""}
                  onChange={(e) => setEditing((prev) => ({ ...prev, [cluster.clusterId]: e.target.value }))}
                />
                <button
                  type="button"
                  disabled={busy === cluster.clusterId}
                  onClick={() => {
                    const typed = editing[cluster.clusterId]?.trim();
                    const fallback = cluster.currentLabel.replace(/^疑似\s*/, "");
                    void act(cluster.clusterId, typed || fallback);
                  }}
                >
                  确认
                </button>
                <button
                  type="button"
                  className="quiet-button"
                  disabled={busy === cluster.clusterId}
                  onClick={() => void act(cluster.clusterId, null)}
                >
                  跳过
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
