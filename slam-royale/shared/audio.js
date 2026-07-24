// Named sound-cue slots, admin-configurable via the Studio's Audio Mixer (a per-slot
// volume + an uploaded sample) — see client/sound.js (playback/mixing),
// client/sound-sync.js + server/api.js (persistence), client/studio.js (mixer UI).
// Add a slot here (and to its group + label below) to make it configurable; actually
// triggering it is wired up separately wherever that moment happens — see
// client/net.js (your own predicted actions), client/main.js (server-broadcast combat
// events + match end), server/world.js (pickups, pushed as events so they're
// authoritative and not guessed at client-side).
//
// grabStart (committing to a grab) vs grabbed (being thrown by one that connected)
// are deliberately separate slots, same split as light1/heavy (attacker's swing)
// vs hit (getting struck) — "did I just do this" and "did this just happen to me"
// are different moments even for the same move.
export const SOUND_GROUPS = [
  ['Combat — your attacks', ['light1','light2','light3','heavy','grabStart','superAttack','dodge','throw']],
  ['Combat — reactions (either fighter)', ['hit','grabbed','clash','stunned','block','dead']],
  ['Movement', ['jump','land','guardUp']],
  ['Pickups & Superstar', ['itemPickup','orbPickup','superstarActivate']],
  ['Match', ['battleStart','matchWin','matchLose']],
  ['Feedback', ['staminaDenied']],
];
export const SOUND_SLOTS = SOUND_GROUPS.flatMap(g => g[1]);
export const SOUND_LABELS = {
  light1: 'Light 1', light2: 'Light 2', light3: 'Light 3', heavy: 'Heavy',
  grabStart: 'Grab (commit)', superAttack: 'Super attack (star slam)', dodge: 'Dodge', throw: 'Throw',
  hit: 'Hit (struck by a strike)', grabbed: 'Grabbed (thrown)', clash: 'Clash (matching moves collide)',
  stunned: 'Stunned (stamina exhausted)',
  block: 'Block (chip impact)', dead: 'Knocked out',
  jump: 'Jump', land: 'Land', guardUp: 'Guard up (block start)',
  itemPickup: 'Item pickup', orbPickup: 'Orb pickup', superstarActivate: 'Superstar activate',
  battleStart: 'Battle start (countdown alarm)', matchWin: 'Match win', matchLose: 'Match lose',
  staminaDenied: 'Stamina denied (rejected press)',
};
