import { useCallback, useEffect, useState } from 'react';
import { postOnlineMatch } from './api/records';
import { LobbyScene } from './scenes/LobbyScene';
import { MatchLobbyScene, type MatchStartPayload } from './scenes/MatchLobbyScene';
import { type MatchResult, MatchScene } from './scenes/MatchScene';
import { type NetworkedMatchResult, NetworkedMatchScene } from './scenes/NetworkedMatchScene';
import { PasswordResetScene } from './scenes/PasswordResetScene';
import { RankingsScene } from './scenes/RankingsScene';
import { ResultScene } from './scenes/ResultScene';
import { TitleScene } from './scenes/TitleScene';
import { loadAccount } from './state/account';
import { applyColorModeDom } from './state/colorMode';
import { appendOnlineHistory, loadRecords } from './state/records';
import { loadSettings } from './state/settings';

type SceneKind =
  | 'title'
  | 'match'
  | 'result'
  | 'lobby'
  | 'matchLobby'
  | 'networkedMatch'
  | 'rankings'
  | 'passwordReset';

/** Extract a `#reset/<token>` token from the current location hash. */
function readResetToken(): string | null {
  const m = /^#reset\/([^/?#]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1] ?? '') : null;
}

export function App() {
  const initialToken = typeof window !== 'undefined' ? readResetToken() : null;
  const [scene, setScene] = useState<SceneKind>(initialToken ? 'passwordReset' : 'title');
  const [resetToken, setResetToken] = useState<string | null>(initialToken);
  const [matchKey, setMatchKey] = useState(0);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [matchRoomId, setMatchRoomId] = useState('');
  const [matchNickname, setMatchNickname] = useState('');
  const [networkedStart, setNetworkedStart] = useState<MatchStartPayload | null>(null);

  // Keep the deep-link reset flow reactive — if the user opens the
  // emailed link while the tab is already up, we should still pick it
  // up rather than ignoring it until a page reload.
  useEffect(() => {
    function onHash() {
      const tok = readResetToken();
      if (tok) {
        setResetToken(tok);
        setScene('passwordReset');
      }
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const exitReset = useCallback(() => {
    // Drop the hash so a refresh doesn't drop us back into the flow.
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    setResetToken(null);
    setScene('title');
  }, []);

  // Apply persisted color mode on first paint so the user's previous
  // pick survives a reload. Settings volumes are applied lazily inside
  // the audio bus the first time it's unlocked.
  useEffect(() => {
    applyColorModeDom(loadSettings().colorMode);
  }, []);

  const startMatch = useCallback(() => {
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

  switch (scene) {
    case 'passwordReset':
      if (!resetToken)
        return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
      return <PasswordResetScene token={resetToken} onDone={exitReset} />;
    case 'title':
      return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
    case 'match':
      return <MatchScene key={matchKey} onEnd={handleEnd} onQuit={handleQuit} />;
    case 'result':
      if (!result)
        return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
      return <ResultScene result={result} onRestart={startMatch} onTitle={handleQuit} />;
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
      if (!networkedStart)
        return <TitleScene onStart={startMatch} onOnline={goOnline} onRankings={goRankings} />;
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
          onEnd={handleNetworkedMatchEnd}
          onQuit={handleNetworkedQuit}
        />
      );
  }
}
