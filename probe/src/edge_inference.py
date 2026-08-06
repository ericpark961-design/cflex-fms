"""엣지 예지 — Phase 2 (Tier B-5 ~ B-7).

전부 결정론·경량(클라우드 의존 0). 데이터 쌓이면 회귀로 교체 가능.

  1. 배터리 EOL  — 통계/수명곡선 룰 (온도 10°C↑ → 수명 절반)
  2. 이상탐지    — 장비별 EWMA 베이스라인 + N σ 이탈
  3. 부하/온도 ETA — EWMA + 선형 외삽으로 임계 도달 ETA

원본 데이터 시계열은 probe/src/buffer.py 의 readings 테이블에서 가져온다.
본 모듈은 순수 함수 — 시계열을 list[dict] 로 받아 결과만 반환.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Sequence
import math
import time


# ── 1. 배터리 EOL (Tier B-5, Schneider·Eaton 헤드라인 패리티) ────────────

# 배터리 화학 표준 — 25°C 베이스라인 수명(개월).
# VRLA(밀폐형 납축전지) APC Smart-UPS 표준: 3~5년 ≈ 36~60개월.
# 보수적 5년 = 60개월을 베이스로.
BATTERY_BASELINE_MONTHS = 60.0
ARRHENIUS_HALVE_DELTA_C = 10.0   # 표준: 평균온도 10°C↑ → 수명 절반.
TEMP_REFERENCE_C = 25.0          # 베이스라인 온도.

# 화학 마모 가속 (Cycle Counting) — 데이터 쌓이면 회귀로 교체.
CYCLE_PENALTY_PER_DEEP = 0.5     # 깊은 방전 1회 → 0.5개월 단축.


@dataclass
class BatteryEOL:
    months_remaining: float | None      # 잔여 수명(개월). None=데이터부족.
    confidence: str                      # low|mid|high — 표본 크기·일관성.
    reasons: list[str]                   # 사람말 설명
    recommend_replace: bool              # 권고 — 잔여 ≤ 3개월
    inputs: dict                          # 입력 요약 (감사 로그용)


def battery_eol_v1(
    avg_temp_c: float | None,
    installed_at_ts: float | None,
    deep_discharge_cycles: int = 0,
    *,
    samples_n: int = 0,
    now_ts: float | None = None,
) -> BatteryEOL:
    """배터리 잔여수명(EOL) v1 — 통계/수명곡선 룰.

    아레니우스 근사: 평균 온도가 25°C 기준 ΔC 높으면 수명 = base * 2^(-ΔC/10).
    deep discharge 추가 페널티.

    경량·결정론 — pysnmp/통계만, ML 없음. 30 표본 이상이면 confidence='mid' 이상.
    """
    now = float(now_ts if now_ts is not None else time.time())
    reasons: list[str] = []

    if installed_at_ts is None:
        return BatteryEOL(None, "low", ["설치일 미상 — 잔여 계산 불가"],
                          False, {"avg_temp_c": avg_temp_c})

    age_months = max(0.0, (now - float(installed_at_ts)) / (30.44 * 86400))

    # 1) 베이스라인 — 온도 가속 적용.
    if avg_temp_c is None:
        # 온도 미상 → 25°C 가정. confidence 낮춤.
        effective_base = BATTERY_BASELINE_MONTHS
        reasons.append("배터리 평균온도 미상 — 25°C 가정")
    else:
        delta = float(avg_temp_c) - TEMP_REFERENCE_C
        # 2^(-Δ/10). Δ=+10 → 0.5 (수명 절반). Δ=-10 → 2.0 (수명 두 배, 상한 1.5).
        factor = 2.0 ** (-delta / ARRHENIUS_HALVE_DELTA_C)
        factor = min(1.5, max(0.2, factor))   # 상·하한
        effective_base = BATTERY_BASELINE_MONTHS * factor
        if delta > 5:
            reasons.append(f"평균 {avg_temp_c:.0f}°C — 베이스 25°C보다 +{delta:.0f}°C, "
                            f"수명 {factor:.0%}로 단축")
        elif delta < -5:
            reasons.append(f"평균 {avg_temp_c:.0f}°C — 저온 환경, 수명 {factor:.0%}로 연장")

    # 2) Deep discharge 사이클 패널티
    cycle_pen = float(deep_discharge_cycles) * CYCLE_PENALTY_PER_DEEP
    if cycle_pen > 0:
        reasons.append(f"깊은 방전 {deep_discharge_cycles}회 — {cycle_pen:.0f}개월 단축")

    months_remaining = max(0.0, effective_base - age_months - cycle_pen)

    # 3) confidence
    if samples_n >= 90:
        conf = "high"
    elif samples_n >= 30:
        conf = "mid"
    else:
        conf = "low"
    if avg_temp_c is None and conf != "low":
        conf = "low"

    if age_months > effective_base:
        reasons.append(f"사용 {age_months:.1f}개월 — 베이스 수명 {effective_base:.0f}개월 초과 (교체 권고)")

    recommend = months_remaining <= 3.0

    return BatteryEOL(
        months_remaining=round(months_remaining, 1),
        confidence=conf,
        reasons=reasons,
        recommend_replace=recommend,
        inputs={
            "age_months": round(age_months, 1),
            "avg_temp_c": avg_temp_c,
            "effective_base_months": round(effective_base, 1),
            "deep_discharge_cycles": deep_discharge_cycles,
            "samples_n": samples_n,
        },
    )


# ── 2. AI 이상탐지 (Tier B-6) ────────────────────────────────────────

@dataclass
class AnomalyResult:
    is_anomaly: bool
    z_score: float | None        # 표준편차 단위 이탈 (양음수)
    baseline_mean: float | None
    baseline_std: float | None
    samples_n: int
    reason: str


def anomaly_ewma(
    values: Sequence[float],
    current: float,
    *,
    alpha: float = 0.1,
    sigma_threshold: float = 3.0,
    min_samples: int = 14,
) -> AnomalyResult:
    """EWMA 베이스라인 + N σ 이탈 검출.

    alpha 작을수록 베이스라인 안정(느린 학습).
    sigma=3 표준 — 정규분포 가정 ~0.3% 거짓양성.
    """
    vals = [float(v) for v in values if v is not None]
    n = len(vals)
    if n < min_samples:
        return AnomalyResult(False, None, None, None, n,
                              f"표본 부족 ({n} < {min_samples})")

    # EWMA 평균
    mean = vals[0]
    var = 0.0
    for v in vals[1:]:
        diff = v - mean
        mean += alpha * diff
        var = (1 - alpha) * (var + alpha * diff * diff)
    std = math.sqrt(max(0.0, var))
    if std == 0.0:
        # 분산 0 — 모두 같은 값. current가 다르면 무조건 이상.
        is_anom = current != mean
        return AnomalyResult(is_anom, None, mean, 0.0, n,
                              "분산 0 — 베이스라인 불변" if not is_anom
                              else f"기준값 {mean:.2f}에서 첫 변화 {current:.2f}")

    z = (current - mean) / std
    is_anom = abs(z) >= sigma_threshold
    reason = (f"|z|={abs(z):.2f}σ ≥ {sigma_threshold:.1f}σ (mean={mean:.2f}, std={std:.2f})"
              if is_anom
              else f"|z|={abs(z):.2f}σ < {sigma_threshold:.1f}σ — 정상 범위")
    return AnomalyResult(is_anom, round(z, 2), round(mean, 3),
                          round(std, 3), n, reason)


# ── 3. 부하/온도 ETA (Tier B-7) ─────────────────────────────────────

@dataclass
class ETAResult:
    eta_sec: float | None        # 임계 도달 예상 초. None=절대 도달 안 함(또는 추세 평탄).
    slope_per_sec: float | None  # 변화율 (단위/초)
    current: float
    threshold: float
    reason: str


def threshold_eta_linear(
    samples: Sequence[tuple[float, float]],
    *,
    threshold: float,
    direction: str = "increasing",
    min_samples: int = 6,
) -> ETAResult:
    """선형 외삽으로 임계 도달 ETA.

    samples: [(ts_epoch_sec, value), ...]. 시간순.
    direction='increasing': value↑ → threshold 도달 시각.
              'decreasing': value↓ → threshold 도달 시각.

    추세 평탄/반대면 eta=None.
    """
    pts = [(float(t), float(v)) for t, v in samples if t is not None and v is not None]
    if len(pts) < min_samples:
        return ETAResult(None, None, pts[-1][1] if pts else 0.0, threshold,
                          f"표본 부족 ({len(pts)} < {min_samples})")
    # 최소제곱 1차 회귀
    n = len(pts)
    t0 = pts[0][0]
    xs = [t - t0 for t, _ in pts]
    ys = [v for _, v in pts]
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return ETAResult(None, 0.0, ys[-1], threshold, "시간 분산 0")
    slope = num / den
    intercept_at_last = ys[-1]
    current_t = pts[-1][0]

    if direction == "increasing":
        if slope <= 0:
            return ETAResult(None, round(slope, 6), ys[-1], threshold,
                              "추세 평탄/하락 — 임계 도달 안 함")
        if ys[-1] >= threshold:
            return ETAResult(0.0, round(slope, 6), ys[-1], threshold,
                              "이미 임계 초과")
        eta = (threshold - ys[-1]) / slope
    else:  # decreasing
        if slope >= 0:
            return ETAResult(None, round(slope, 6), ys[-1], threshold,
                              "추세 평탄/상승 — 임계 도달 안 함")
        if ys[-1] <= threshold:
            return ETAResult(0.0, round(slope, 6), ys[-1], threshold,
                              "이미 임계 미만")
        eta = (threshold - ys[-1]) / slope

    return ETAResult(
        eta_sec=round(max(0.0, eta), 1),
        slope_per_sec=round(slope, 6),
        current=ys[-1],
        threshold=threshold,
        reason=f"선형 외삽: 현재 {ys[-1]:.2f}, slope {slope:.4f}/s → {eta/3600:.1f}h 후 임계 {threshold}",
    )
