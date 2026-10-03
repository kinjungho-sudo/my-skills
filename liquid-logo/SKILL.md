---
name: liquid-logo
description: 로고·SVG·도형을 "리퀴드 메탈" 효과(움직이는 액체 금속 질감)로 만들어 웹에 넣을 때 사용. "liquid logo", "liquid metal", "리퀴드 메탈 로고", "액체 금속 로고", "로고를 메탈 질감으로", "paper design shader", "LiquidMetal 컴포넌트", "liquid.paper.design 같은 효과" 같은 요청에 반드시 사용. 원리 설명, @paper-design/shaders-react의 LiquidMetal 적용, 로고 이미지 준비 팁, 파라미터 튜닝, 라이선스 주의까지 다룬다.
---

# liquid-logo (리퀴드 메탈 로고)

paper-design/liquid-logo는 업로드한 로고를 움직이는 액체 금속처럼 렌더링하는 데모 앱이다
(https://liquid.paper.design). 결과물을 만들거나 사이트에 넣을 때는 **데모 소스를 복사하지 말고**,
같은 효과를 내는 공식 패키지 `@paper-design/shaders-react`의 `LiquidMetal`을 쓴다.

## 라이선스 주의 (중요)

- `paper-design/liquid-logo` 저장소는 **PolyForm Shield 1.0.0** 라이선스다. 개인·일반 용도는 허용되지만,
  이 소스를 가져와 Paper와 경쟁하는 제품·서비스를 만드는 건 금지이고, 배포 시 라이선스 고지가 필요하다.
  그래서 이 스킬에는 원본 소스를 넣지 않고 원리와 사용법만 정리했다.
- 사이트에 효과를 넣는 일반적인 경우엔 npm 패키지 `@paper-design/shaders-react`(Apache-2.0 표기, 작성 시점 v0.0.81)를 쓰면 된다.
  상용·재배포 용도라면 설치한 패키지의 LICENSE를 직접 확인할 것.

## 효과가 만들어지는 원리

1. **로고를 마스크로 변환**: 흰색/투명 배경을 "바깥", 나머지를 "도형 안쪽"으로 본다.
2. **가장자리 거리장 생성**: 경계에서 0, 안쪽으로 갈수록 커지는 값을 푸아송 방정식(반복 풀이, 데모는 약 300회)으로 구해
   부드러운 "볼록한 단면" 같은 그레이스케일 맵(R=엣지 그라디언트)을 만든다. 이 맵이 금속의 입체감을 결정한다.
3. **프래그먼트 셰이더**: 이 맵에 simplex noise로 왜곡한 줄무늬 패턴을 입히고, 줄무늬 경계를 부드럽게 섞고,
   R/B 채널을 어긋나게(분산, dispersion) 해서 크롬 같은 색 번짐을 만든다. 시간 uniform으로 패턴이 흐른다.
4. 데모 앱은 WebGL2 캔버스 하나에 풀스크린 쿼드를 그리고, 슬라이더 값을 URL 쿼리로 동기화해 공유 링크를 만든다.

## 사이트에 적용하기 (권장)

```bash
npm i @paper-design/shaders-react
```

```tsx
'use client' // Next.js App Router
import { LiquidMetal } from '@paper-design/shaders-react'

export function LogoMetal() {
  return (
    <LiquidMetal
      image="/logo.svg"          // 흰색/투명 배경의 로고
      style={{ width: 400, height: 400 }}
      colorBack="#00000000"
      colorTint="#ffffff"
      repetition={2}
      softness={0.3}
      shiftRed={0.3}
      shiftBlue={0.3}
      distortion={0.07}
      contour={0.4}
      angle={70}
      speed={0.3}
    />
  )
}
```

- 파라미터는 `LiquidMetalParams` 기준: `colorBack`, `colorTint`, `image`, `repetition`(1~10), `shiftRed`/`shiftBlue`(-1~1),
  `contour`(0~1), `softness`(0~1), `distortion`(0~1), `angle`(0~360), `shape`(이미지 없이 쓰는 기본 도형: circle/daisy/diamond/metaballs), `speed` 등.
  실제 값 범위와 프리셋(`liquidMetalPresets`: default / noir / fullScreen / stripes)은 설치한 버전의 타입 정의로 확인한다.
- 로고 이미지 전처리(마스크→거리장)는 컴포넌트가 처리한다. 처리 중 Suspense를 쓰려면 `suspendWhenProcessingImage`.
- 컨테이너에 **명시적 크기**를 줘야 보인다. 배경은 투명으로 두고 부모 CSS 배경(예: 은회색 그라디언트)과 조합하면 금속감이 산다.

## 데모 앱 파라미터 ↔ 패키지 파라미터 (대응은 의미상 추정)

데모 슬라이더 범위(기본값)는 아래와 같다. 이름은 패키지와 다르니 감을 잡는 용도로만 쓴다.

| 데모 슬라이더 | 범위 (기본) | 패키지에서 가장 가까운 파라미터 |
|---|---|---|
| Dispersion(내부명 refraction) | 0~0.06 (0.015) | `shiftRed` / `shiftBlue` |
| Edge | 0~1 (0.4) | `contour` |
| Pattern Blur | 0~0.05 (0.005) | `softness` |
| Liquify | 0~1 (0.07) | `distortion` |
| Speed | 0~1 (0.3) | `speed` |
| Pattern Scale | 1~10 (2) | `repetition` |

값이 정확히 같은 스케일은 아니므로 눈으로 보며 조정한다.

## 좋은 결과를 위한 로고 준비 팁

- **투명 또는 순백(#fff) 배경**이 필수. 그 외는 전부 도형으로 인식된다.
- **글자보다 단순한 도형**이 잘 나온다. 얇은 글자는 거리장이 평평해져 금속감이 약하다.
- **SVG 또는 고해상도 이미지** 사용(데모는 500~1000px로 정규화, 업로드 4.5MB 제한).
- 도형 안쪽이 두꺼울수록 입체감이 커진다. 가는 선 로고는 외곽선을 굵게 만들어 쓴다.

## 성능·접근성

- 풀스크린 WebGL이라 모바일에서는 크기·DPR을 제한하고, 한 페이지에 여러 개를 두지 않는다.
- 화면 밖에서는 렌더를 멈추거나 언마운트한다. `prefers-reduced-motion`이면 `speed={0}`.
- 의미 있는 로고면 부모에 `role="img"`와 `aria-label`을 준다. WebGL2 미지원 브라우저를 위해 정적 PNG/SVG 폴백을 둔다.

## 참고

- 데모: https://liquid.paper.design
- 데모 소스(PolyForm Shield 1.0.0): https://github.com/paper-design/liquid-logo
- 패키지: https://www.npmjs.com/package/@paper-design/shaders-react
