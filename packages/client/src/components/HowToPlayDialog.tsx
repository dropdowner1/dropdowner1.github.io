/**
 * HowToPlayDialog — first-time-player rules briefing.
 *
 * Pops over the title or result screen so a new player can learn the
 * core loop in one screen:
 *   1. 4個つなげると消える
 *   2. 連鎖でスコアと送りぷよが増える
 *   3. 上の段に積み上がるとゲームオーバー
 *
 * Plus a compact controls summary so the on-canvas keyhint isn't the
 * only place key bindings live.
 */

import { useCallback, useEffect } from 'react';

interface Props {
  onClose: () => void;
}

export function HowToPlayDialog({ onClose }: Props) {
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="snes-window how-to-play">
      <h2 className="how-to-play-title">遊び方</h2>

      <ol className="how-to-play-list">
        <li>
          <span className="how-to-play-step">1</span>
          <div>
            <p className="how-to-play-headline">同じ色を 4 つ繋げて消す</p>
            <p className="how-to-play-detail">
              落ちてくる 2 個 1 組のぷよを、縦か横で 4 つ以上つなげると消えます。
            </p>
          </div>
        </li>
        <li>
          <span className="how-to-play-step">2</span>
          <div>
            <p className="how-to-play-headline">連鎖でスコアが伸びる</p>
            <p className="how-to-play-detail">
              消したあとに別の塊が新しく 4
              つ揃うと連鎖が成立。連鎖が長いほど得点が爆発し、対戦では相手におじゃまぷよを送れます。
            </p>
          </div>
        </li>
        <li>
          <span className="how-to-play-step">3</span>
          <div>
            <p className="how-to-play-headline">上端に積みあがると負け</p>
            <p className="how-to-play-detail">
              フィールドの上まで埋まったらゲームオーバー。崩れる前に大きな連鎖を組むのが目標です。
            </p>
          </div>
        </li>
      </ol>

      <div className="how-to-play-controls">
        <h3 className="how-to-play-subtitle">操作</h3>
        <dl className="how-to-play-keys">
          <div>
            <dt>← →</dt>
            <dd>移動</dd>
          </div>
          <div>
            <dt>Z / X</dt>
            <dd>左 / 右回転</dd>
          </div>
          <div>
            <dt>↓</dt>
            <dd>ソフトドロップ(高速落下)</dd>
          </div>
          <div>
            <dt>Esc</dt>
            <dd>ポーズ</dd>
          </div>
        </dl>
      </div>

      <div className="how-to-play-actions">
        <button type="button" className="pause-btn pause-btn-primary" onClick={close}>
          閉じる
        </button>
      </div>
    </div>
  );
}
