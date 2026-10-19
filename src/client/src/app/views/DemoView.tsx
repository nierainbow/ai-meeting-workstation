import type { DiscussionDetailDto } from "../../../../shared/types";
import { fragmentPreview } from "../format";

export function DemoView(props: {
  discussion: DiscussionDetailDto | null;
  isOpen: boolean;
  latestAiResponse: string;
  onClose: () => void;
}) {
  const { discussion, isOpen, latestAiResponse, onClose } = props;
  const finalCount = discussion?.utterances.filter((utterance) => utterance.isFinal).length ?? 0;

  return (
    <div className={isOpen ? "knowledge-layer open" : "knowledge-layer"} aria-hidden={!isOpen}>
      <button type="button" className="knowledge-backdrop" onClick={onClose} aria-label="关闭企业知识库 Demo" />
      <aside className="knowledge-drawer" role="dialog" aria-modal="true" aria-label="企业知识库 Demo">
        <header className="knowledge-drawer-header">
          <div>
            <span>Enterprise memory</span>
            <h2>企业知识库</h2>
          </div>
          <div className="knowledge-drawer-actions">
            <button type="button" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </header>

        <section className="knowledge-intro">
          <span className="knowledge-signal" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>企业的每一次讨论，都在训练自己的决策上下文</strong>
            <p>会议结束后，系统将关键决策、战略方向、客户信号和行动项沉淀为可追溯知识。下一次开会，AI 不再从零开始。</p>
          </div>
        </section>

        <section className="knowledge-metrics" aria-label="知识库演示指标">
          <article><strong>128</strong><span>场会议已沉淀</span><small>较上月 +18</small></article>
          <article><strong>36</strong><span>项关键决策</span><small>9 项待复盘</small></article>
          <article><strong>12</strong><span>条战略主线</span><small>覆盖 4 个部门</small></article>
          <article><strong>8</strong><span>项风险预警</span><small>3 项需跟进</small></article>
        </section>

        <section className="knowledge-current-meeting">
          <header>
            <div>
              <span>本次会议即将沉淀</span>
              <h3>AI 参与企业会议：实时协同与知识沉淀</h3>
            </div>
            <em>{finalCount} 条有效片段</em>
          </header>
          <div className="knowledge-extracts">
            <article>
              <span>关键决策</span>
              <p>{latestAiResponse ? fragmentPreview(latestAiResponse) : "AI 将从会议内容中提炼已确认的选择、负责人和判断依据。"}</p>
            </article>
            <article>
              <span>后续行动</span>
              <p>把明确的任务、负责人和时间节点转为可跟踪的行动项。</p>
            </article>
          </div>
        </section>

        <section className="knowledge-library">
          <header>
            <span>Knowledge map</span>
            <h3>企业知识地图</h3>
          </header>
          <div className="knowledge-card-grid">
            <article><span>01</span><strong>战略部署</strong><p>长期目标、阶段重点与资源取舍</p><em>24 条知识</em></article>
            <article><span>02</span><strong>关键决策</strong><p>结论、依据、参与者与后续结果</p><em>36 条知识</em></article>
            <article><span>03</span><strong>客户洞察</strong><p>需求变化、异议、承诺与合作信号</p><em>51 条知识</em></article>
            <article><span>04</span><strong>项目进展</strong><p>里程碑、阻塞点、负责人和复盘</p><em>67 条知识</em></article>
          </div>
        </section>

        <section className="knowledge-evolution">
          <header><span>AI 如何越来越懂企业</span><strong>从单次助理到企业决策伙伴</strong></header>
          <ol>
            <li><span>01</span><div><strong>第一次会议</strong><p>理解本次对话与显式背景</p></div></li>
            <li><span>02</span><div><strong>持续积累</strong><p>连接历史决策、客户与项目脉络</p></div></li>
            <li><span>03</span><div><strong>企业级 AI</strong><p>在权限范围内提供更贴合战略的建议</p></div></li>
          </ol>
        </section>

        <footer className="knowledge-demo-note">
          <strong>演示边界</strong>
          <p>当前页面仅展示产品形态，不读取真实企业知识库。正式版本需接入客户授权的数据源、权限体系与可追溯引用。</p>
        </footer>
      </aside>
    </div>
  );
}
