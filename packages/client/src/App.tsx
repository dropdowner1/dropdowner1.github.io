import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { postOnlineMatch } from './api/records';
import { DifficultyScene } from './scenes/DifficultyScene';
import { LobbyScene } from './scenes/LobbyScene';
import { MatchLobbyScene, type MatchStartPayload } from './scenes/MatchLobbyScene';
import { type MatchResult, MatchScene } from './scenes/MatchScene';
import { type NetworkedMatchResult, NetworkedMatchScene } from './scenes/NetworkedMatchScene';
import { RankingsScene } from './scenes/RankingsScene';
import { ResultScene } from './scenes/ResultScene';
import { TitleScene } from './scenes/TitleScene';
import { useSession } from './state/SessionContext';
import { loadAccount } from './state/account';
import { applyColorModeDom } from './state/colorMode';
import { type DifficultyLevel, fallIntervalFor, loadDifficulty } from './state/difficulty';
import { appendOnlineHistory, loadRecords } from './state/records';
import { loadSettings } from './state/settings';

type SceneKind =
  | 'title'
  | 'soloDifficulty'
  | 'match'
  | 'result'
  | 'lobby'
  | 'matchLobby'
  | 'networkedMatch'
  | 'rankings';

export function App() {
  const { refresh: refreshSession } = useSession();
  const [scene, setScene] = useState<SceneKind>('title');
  /** Result of a Techmana round-trip, shown once then dismissed. */
  const [techmanaNotice, setTechmanaNotice] = useState<Notice | null>(null);
  const [matchKey, setMatchKey] = useState(0);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [matchRoomId, setMatchRoomId] = useState('');
  const [matchNickname, setMatchNickname] = useState('');
  const [networkedStart, setNetworkedStart] = useState<MatchStartPayload | null>(null);
  /** Solo difficulty for the upcoming MatchScene. Picker writes this. */
  const [soloDifficulty, setSoloDifficulty] = useState<DifficultyLevel>(() => loadDifficulty());
  /** Bumped when the browser Back button is pressed during an online
   *  match; NetworkedMatchScene watches this to open its leave-confirm
   *  rather than the match being silently abandoned. */
  const [networkedBackSignal, setNetworkedBackSignal] = useState(0);

  /** Mirror of `scene` for the (mount-once) popstate handler to read. */
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  // Apply persisted color mode on first paint so the user's previous
  // pick survives a reload. Settings volumes are applied lazily inside
  // the audio bus the first time it's unlocked.
  useEffect(() => {
    applyColorModeDom(loadSettings().colorMode);
  }, []);

  // ---------------------------------------------------------------
  // Techmana callback.
  //
  // The server finishes the OAuth exchange and sends the browser back
  // here with ?techmana=ok (or =error&reason=…). Read it, strip it,
  // and re-probe /me so the freshly-set session cookie takes effect.
  //
  // Stripping matters: the query has to be gone before the history
  // trap below pushes its sentinel, otherwise a reload would replay
  // the banner for a link that happened minutes ago.
  // ---------------------------------------------------------------
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('techmana');
    if (flag === null) return;

    const reason = params.get('reason');
    params.delete('techmana');
    params.delete('reason');
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    );

    if (flag === 'ok') {
      setTechmanaNotice({
        kind: 'ok',
        text: 'テクマナと連携しました。セーブデータはアカウントに保存されます。',
      });
      void refreshSession();
    } else {
      setTechmanaNotice({ kind: 'error', text: techmanaErrorText(reason) });
    }
  }, [refreshSession]);

  /** Tapped from the title screen; jumps to the difficulty picker. */
  const startMatch = useCallback(() => {
    setScene('soloDifficulty');
  }, []);

  /** Difficulty picker confirmed; spin up MatchScene with chosen pace. */
  const confirmDifficulty = useCallback((level: DifficultyLevel) => {
    setSoloDifficulty(level);
    setMatchKey((k) => k + 1);
    setScene('match');
  }, []);

  /** "Try again" from the result screen → re-use the same difficulty. */
  const restartMatch = useCallback(() => {
    setMatchKey((k) => k + 1);
    setScene('match');
  }, []);

  const handleEnd = useCallback((r: MatchResult) => {
    setResult(r);
    setScene('result');
  }, []);

  const handleQuit = useCallback(() => {
    setResult(null);
    setScene('title');
  }, []);

  // ---------------------------------------------------------------
  // Browser Back handling.
  //
  // With no router, a raw Back press would leave the site entirely
  // (and, mid-match, silently abandon the game). We install one
  // always-armed history "trap": on mount we push a sentinel entry,
  // and every popstate re-pushes it and instead routes Back UP one
  // logical screen. Net history growth is zero (each pop consumes one
  // entry, we push one back), so this never balloons the back stack.
  //
  //   difficulty / lobby / rankings → title
  //   matchLobby                    → lobby (unmount leaves the room)
  //   solo match / result           → title (quit)
  //   online match                  → open the leave-confirm (no
  //                                    navigation until the player OKs)
  //   title                         → stay (root; Back is a no-op)
  // ---------------------------------------------------------------
  useEffect(() => {
    window.history.pushState({ chaindropTrap: true }, '');
    const onPopState = () => {
      // Re-arm so the next Back is caught too.
      window.history.pushState({ chaindropTrap: true }, '');
      switch (sceneRef.current) {
        case 'soloDifficulty':
        case 'lobby':
        case 'rankings':
          setScene('title');
          break;
        case 'matchLobby':
          setScene('lobby');
          break;
        case 'match':
        case 'result':
          handleQuit();
          break;
        case 'networkedMatch':
          // Don't abandon a live match on Back — ask first.
          setNetworkedBackSignal((n) => n + 1);
          break;
        default:
          // title — stay put; the trap keeps us in the app.
          break;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [handleQuit]);

  const goOnline = useCallback(() => {
    setScene('lobby');
  }, []);

  const goRankings = useCallback(() => {
    setScene('rankings');
  }, []);

  const handleJoinMatch = useCallback((roomId: string, nick: string) => {
    setMatchRoomId(roomId);
    setMatchNickname(nick);
    setScene('matchLobby');
  }, []);

  const handleNetworkedMatchStart = useCallback((payload: MatchStartPayload) => {
    setNetworkedStart(payload);
    setScene('networkedMatch');
  }, []);

  const handleNetworkedMatchEnd = useCallback(
    (r: NetworkedMatchResult) => {
      // A desync is an invalid match: show the result for context but
      // DON'T pollute win/loss history with a bogus draw.
      if (r.reason !== 'desync') {
        // Resolve the opponent's nickname from the MatchStartPayload —
        // in 1v1 there's exactly one other id in playerOrder.
        const opponentId = networkedStart?.playerOrder.find((id) => id !== r.myPlayerId);
        const opponentNickname =
          (opponentId && networkedStart?.nicknamesByPlayerId[opponentId]) || '対戦相手';
        const outcome: 'win' | 'loss' | 'draw' =
          r.winnerId === null ? 'draw' : r.winnerId === r.myPlayerId ? 'win' : 'loss';
        appendOnlineHistory(loadRecords(), {
          at: new Date().toISOString(),
          opponentNickname,
          outcome,
          selfScore: r.score,
        });
        // Push to the server too — silent on failure (guests etc).
        void postOnlineMatch({ opponentName: opponentNickname, outcome, selfScore: r.score });
      }
      setResult({ score: r.score, maxChain: r.maxChain, frame: r.frame });
      setNetworkedStart(null);
      setScene('result');
    },
    [networkedStart],
  );

  const handleNetworkedQuit = useCallback(() => {
    setNetworkedStart(null);
    setScene('title');
  }, []);

  const renderScene = (): ReactElement => {
    switch (scene) {
      case 'title':
        return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
      case 'soloDifficulty':
        return <DifficultyScene onConfirm={confirmDifficulty} onBack={() => setScene('title')} />;
      case 'match':
        return (
          <MatchScene
            key={matchKey}
            fallIntervalNormal={fallIntervalFor(soloDifficulty)}
            onEnd={handleEnd}
            onQuit={handleQuit}
          />
        );
      case 'result':
        if (!result) {
          // Shouldn't happen — a transition to 'result' always sets one
          // first. Warn so a races shows up in dev, and fall back safely.
          console.warn('[App] result scene with no result; falling back to title');
          return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
        }
        return <ResultScene result={result} onRestart={restartMatch} onTitle={handleQuit} />;
      case 'lobby':
        return <LobbyScene onJoinMatch={handleJoinMatch} onBack={() => setScene('title')} />;
      case 'matchLobby':
        return (
          <MatchLobbyScene
            roomId={matchRoomId}
            nickname={matchNickname || loadAccount().playerName}
            onLeave={() => setScene('lobby')}
            onMatchStart={handleNetworkedMatchStart}
          />
        );
      case 'rankings':
        return <RankingsScene onBack={() => setScene('title')} />;
      case 'networkedMatch':
        if (!networkedStart) {
          console.warn('[App] networkedMatch scene with no start payload; falling back to title');
          return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
        }
        return (
          <NetworkedMatchScene
            room={networkedStart.room}
            myPlayerId={networkedStart.myPlayerId}
            playerOrder={networkedStart.playerOrder}
            nicknamesByPlayerId={networkedStart.nicknamesByPlayerId}
            seed={networkedStart.seed}
            colorMode={networkedStart.colorMode}
            dropQueue={
              networkedStart.dropQueue as unknown as ReadonlyArray<
                readonly [
                  import('@chaindrop/shared').PuyoColor,
                  import('@chaindrop/shared').PuyoColor,
                ]
              >
            }
            backSignal={networkedBackSignal}
            onEnd={handleNetworkedMatchEnd}
            onQuit={handleNetworkedQuit}
          />
        );
    }
  };

  return (
    <>
      {techmanaNotice && (
        <output className={`techmana-notice techmana-notice-${techmanaNotice.kind}`}>
          <span>{techmanaNotice.text}</span>
          <button
            type="button"
            className="techmana-notice-close"
            aria-label="閉じる"
            onClick={() => setTechmanaNotice(null)}
          >
            ×
          </button>
        </output>
      )}
      {renderScene()}
    </>
  );
}

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

/** Map the server's `reason` query param onto something a player can act on. */
function techmanaErrorText(reason: string | null): string {
  switch (reason) {
    case 'denied':
      return 'テクマナ側で連携が許可されませんでした。';
    case 'expired':
    case 'state':
      return '連携の手続きが時間切れになりました。もう一度お試しください。';
    case 'disabled':
      return 'テクマナ連携は現在利用できません。';
    default:
      return 'テクマナと連携できませんでした。時間をおいてお試しください。';
  }
}
