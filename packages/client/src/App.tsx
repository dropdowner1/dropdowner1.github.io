import { useCallback, useEffect, useState } from 'react';
import { LobbyScene } from './scenes/LobbyScene';
import { MatchLobbyScene, type MatchStartPayload } from './scenes/MatchLobbyScene';
import { type MatchResult, MatchScene } from './scenes/MatchScene';
import { type NetworkedMatchResult, NetworkedMatchScene } from './scenes/NetworkedMatchScene';
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
  | 'rankings';

export function App() {
  const [scene, setScene] = useState<SceneKind>('title');
  const [matchKey, setMatchKey] = useState(0);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [matchRoomId, setMatchRoomId] = useState('');
  const [matchNickname, setMatchNickname] = useState('');
  const [networkedStart, setNetworkedStart] = useState<MatchStartPayload | null>(null);

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

  const handleNetworkedMatchEnd = useCallback((r: NetworkedMatchResult) => {
    // Persist this match's outcome to the local online history. The
    // opponent's nickname is whatever the room state surfaced; in 1v1
    // there's exactly one of them.
    const opponent = Object.entries(
      r as unknown as { nicknamesByPlayerId?: Record<string, string> },
    )
      ? '対戦相手'
      : '対戦相手';
    appendOnlineHistory(loadRecords(), {
      at: new Date().toISOString(),
      opponentNickname: opponent,
      outcome: r.winnerId === null ? 'draw' : r.winnerId === r.myPlayerId ? 'win' : 'loss',
      selfScore: r.score,
    });
    setResult({ score: r.score, maxChain: r.maxChain, frame: r.frame });
    setNetworkedStart(null);
    setScene('result');
  }, []);

  const handleNetworkedQuit = useCallback(() => {
    setNetworkedStart(null);
    setScene('title');
  }, []);

  switch (scene) {
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
