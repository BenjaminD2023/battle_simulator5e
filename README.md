# Battle Simulator 5e

A React + Vite tactical combat simulator for D&D 5e SRD 5.1 playtesting.

Live site: https://benjamind2023.github.io/battle_simulator5e/

## What Is Implemented

- Deterministic dice rolling with editable seed values.
- Initiative, movement planning, attack rolls, saving throw actions, damage, healing, round resolution, and win-condition checks.
- SRD 5.1 monster import through the D&D 5e API, cached locally in IndexedDB.
- Manual content builder for monsters and players.
- Player builder defaults that follow 5e SRD-style math: level-based proficiency, Dexterity initiative, attack bonus, weapon damage modifier, and spell save DC.
- SRD character builder for player characters using API-backed class, race, weapon, and spell data.
- Custom, imported, third-party, and draft content use the same action/effect schema as SRD content.
- JSON import/export for content packs.
- Canvas tactical map with uploaded image support, grid detection, manual grid calibration, token movement, and distance measurement.
- Editable per-combatant action intent, target, movement, advantage/disadvantage, HP, AC, speed, and strategy.

## Development

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Verification

```bash
npm run lint
npm run build
```

The project is pinned to Vite 5 because the scaffolded newer Vite/Rolldown stack requires a newer Node 22 patch version than the local runtime provides.
