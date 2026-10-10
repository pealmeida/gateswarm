# Quota Band Matrix — Usage Guide

## Overview

The Quota Band Matrix feature automatically adjusts routing matrices based on provider quota consumption levels. This prevents quota exhaustion by shifting traffic away from providers nearing their limits.

**Version:** 0.7.0  
**Status:** MVP (Minimum Viable Product)  
**Feature Flag:** `GATESWARM_QUOTA_BAND_MATRIX` (default OFF)

## How It Works

### Bands

The system divides quota consumption into four bands:

| Band   | Range    | State     | Description |
|--------|----------|-----------|-------------|
| 🟢 Green  | 0-40%    | Healthy   | Use moderate/balanced tier selections |
| 🟡 Yellow | 40-70%   | Warning   | Current default matrix (bit-identical to 0.6.x) |
| 🟠 Orange | 70-85%   | Alert     | Shift heavy workloads away from hot providers |
| 🔴 Red    | 85-100%  | Critical  | Aggressive load shedding - minimize hot provider usage |

### Selection Algorithm

1. **Compute max(%)** across all providers using 5h window (fallback to weekly if 5h not available)
2. **Select band** based on max%
3. **Apply provider overlays** when specific providers are hot (>70%)
4. **Return effective matrix** for routing decisions

### Provider Overlays

Overlays are evaluated **per provider** with their own yellow/orange/red thresholds (defaults are conservative and
configurable in `provider_rules`; Claude/Codex/Token Plan tiers are plan-dependent, tune for your subscription):

| Provider | Yellow | Orange | Red |
|---|---|---|---|
| Z.AI (`zai_high`, `zai_orange`, `zai_red`) | 50% 5h: drop `glm-5.3` from moderate/heavy | 70%: out of moderate+ | 85%: out of every tier |
| Claude (`claude_yellow`, `claude_high`, `claude_red`) | 40%: Opus leaves the pool | 60%: out of heavy/intensive | 80%: out of every tier |
| Codex (`codex_yellow`, `codex_high`, `codex_red`) | 50%: Astra leaves the pool | 70%: Sol leaves intensive/extreme | 85%: out of every tier |
| Bailian (`bailian_pace`) | monthly pace ≥120% of the linear cycle pace → out of moderate+ (needs `GATESWARM_BAILIAN_CYCLE_START_DAY` and a monthly limit) | | |
| Circuit breaker (`breaker_zai`, `breaker_bailian`, `breaker_claude`, `breaker_codex`) | open breaker (1308 / `insufficient_quota`) → out of every tier until reset | | |

`remove` actions accept an optional `model`, so a single model (e.g. Opus, Astra) can be pulled without dropping the provider.
`both_http_high` is kept for completeness (it needs a 5h percentage for both HTTP providers).

## Configuration

### Enabling the Feature

Set the environment variable:

```bash
export GATESWARM_QUOTA_BAND_MATRIX=1
```

Or in your `.env` file:

```
GATESWARM_QUOTA_BAND_MATRIX=1
```

Accepted values: `1`, `true`, `yes`, `on` (case-insensitive)

### Disabling the Feature

When OFF or unset, the system uses the Yellow/current matrix from `v04_config.json`, providing bit-identical routing to 0.6.x.

```bash
unset GATESWARM_QUOTA_BAND_MATRIX
# or
export GATESWARM_QUOTA_BAND_MATRIX=0
```

### Matrix Configuration

Band matrices are stored in:
```
calibration/matrix-variants/quota_band_matrices.json
```

This file contains:
- `bands`: Four band configurations (green, yellow, orange, red) with tier_models
- `provider_rules`: Five overlay rules with conditions and actions

## Quota Data Sources

The system uses multiple sources in priority order:

1. **quota-sync** (preferred): Real dashboard data from provider scraping
   - File: `data/quota-sync.json`
   - Updated by: `scripts/quota-sync.py` (cron job)

2. **consumption-tracker**: Historical usage patterns
   - File: `data/consumption-history.json`
   - Updated by: Gateway automatically on each request

3. **CLI tools**: For claude-cli/codex-cli if available
   - Source: `getQuotaStatus()` calls

### Missing Data Behavior

When no quota data is available:
- **Band**: Yellow
- **Matrix**: Current default from `v04_config.json`
- **Reason**: `missing_quota`
- **Coverage**: `none`

## Observability

### CLI Commands

```bash
# View current quota-band status
gateswarm quota-band

# View provider quota details
gateswarm quota

# View consumption by window
gateswarm consumption 5h
gateswarm consumption weekly
```

### Response Headers

All `/v1/chat/completions` requests include:

```
X-Quota-Band: yellow
X-Matrix-Variant: yellow
X-Quota-Overlays: go_high,zai_high
```

### Advisory Response Fields

`/v1/score` and `/v06/resolve` endpoints include:

```json
{
  "quotaBand": "orange",
  "matrixVariant": "orange_go_high",
  "overlaysApplied": ["go_high"],
  "maxProviderPct": 72.5,
  "window": "fiveHour",
  "quotaCoverage": "full",
  "providerPct": [
    {
      "provider": "opencodego",
      "maxPct": 72.5,
      "window": "fiveHour",
      "source": "quota_sync"
    },
    {
      "provider": "zai",
      "maxPct": 45.2,
      "window": "fiveHour",
      "source": "quota_sync"
    }
  ]
}
```

### Quota Coverage States

- **full**: All providers have quota data
- **partial**: Some providers have quota data, others unknown
- **none**: No quota data available for any provider

## Testing

### Running Tests

```bash
# Run quota-band matrix tests
npm test -- quota-band-matrix.test.ts

# Run full test suite
npm test

# Run consistency check
npm run check:consistency
```

### Test Scenarios

The test suite covers:
1. Feature flag ON/OFF behavior
2. Band selection (Green/Yellow/Orange/Red)
3. Provider overlay application (go_high, claude_high)
4. Quota coverage states (full/partial/none)
5. Fallback to Yellow on missing/stale data
6. Product criteria from DoD CPO brief

## Product Requirements

### DoD Criteria (Met)

✅ Load band matrices (Green/Yellow/Orange/Red)  
✅ Select band by max(%) across providers (5h → weekly fallback)  
✅ Apply provider overlays (5 rules: zai_*, claude_*, codex_*, bailian_pace, breaker_*, both_http_high)  
✅ Feature flag OFF = bit-identical 0.6.x  
✅ Missing/stale → Yellow + reason  
✅ Transparency: headers + body fields + CLI  
✅ Bump 0.7.0  
✅ Tests: 4 bands + 2 overlays (claude_high, go_high)  

### Product Validation

- **Orange + claude_high**: Heavy tier moves away from Claude ✅
- **Green band**: Moderate tier uses glm-5 (balanced) ✅

## Troubleshooting

### Issue: Feature flag ON but still showing Yellow

**Possible causes:**
1. No quota data available (check `quotaCoverage: none`)
2. All providers below 40% (correctly in Green band, but displaying Yellow due to missing data)
3. `data/quota-sync.json` is stale or corrupted

**Solution:**
```bash
# Check quota status
gateswarm quota-band

# Force rediscovery
gateswarm rediscover

# Check quota sync file
cat data/quota-sync.json
```

### Issue: Overlays not applying

**Possible causes:**
1. Provider percentage below 70% threshold
2. Window data not available (using wrong window)
3. Provider name mismatch in quota data

**Solution:**
```bash
# Check provider percentages
gateswarm quota-band

# View raw consumption data
gateswarm consumption 5h
```

### Issue: Divergence between chat and UI

**Fixed in 0.7.0:** Both `selectModel()` and plan-override paths now use the same effective matrix.

## Limitations (MVP)

- **No ML prediction**: Uses current % only, no trend forecasting
- **No hysteresis**: Band changes immediately on threshold cross
- **Static thresholds**: 70%/85% not adjustable per provider
- **Overlay conflicts**: Precedence by JSON order (document-order wins)
- **CLI data gaps**: claude-cli/codex-cli not in consumption tracker by default

## Future Enhancements (Out of Scope for MVP)

- Hysteresis (band change damping)
- Per-provider threshold configuration
- Trend-based prediction (prevent vs react)
- Smarter overlay conflict resolution
- Real-time scraper integration
- Matrix redesign based on production data

## References

- Implementation: `src/quota-band-matrix.ts`
- Test suite: `tests/quota-band-matrix.test.ts`
- Matrices: `calibration/matrix-variants/quota_band_matrices.json`
- Integration: `src/consumption-intelligence.ts` (line ~110)
- CLI: `src/gateswarm-cli.ts` (cmdQuotaBand)
