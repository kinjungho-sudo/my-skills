---
name: react-three-fiber
description: React Three Fiber(R3F, @react-three/fiber v9 / React 19)로 three.js 3D 장면을 React 컴포넌트로 만들거나 고칠 때 사용. "react three fiber", "r3f", "Canvas", "useFrame", "useThree", "useLoader", "drei", "gltfjsx", "3D 웹", "three.js를 리액트로" 등 요청이나 코드에 @react-three/fiber가 보이면 반드시 사용. 장면 구성, 애니메이션, 이벤트, 모델/텍스처 로딩, 성능 최적화, 테스트, TypeScript 타입 확장을 다룬다.
---

# react-three-fiber (R3F)

three.js를 선언형 React 렌더러로 쓰게 해주는 라이브러리(pmndrs/react-three-fiber, 기준 v9.8.x · React 19).
JSX 태그는 three.js 클래스와 1:1 대응한다(`<mesh>` = `new THREE.Mesh()`). 별도 래퍼가 없어서
three.js에 있는 건 전부 쓸 수 있고, 렌더 비용도 순수 three.js와 같다.

공식 문서 원문은 `references/`에 있다. 아래 요약으로 부족하면 해당 파일을 읽을 것.

## 설치

```bash
npm i three @react-three/fiber
npm i -D @types/three          # TypeScript
npm i @react-three/drei        # 헬퍼 모음(OrbitControls, useGLTF, Environment 등)
```

React 19는 fiber v9, React 18은 fiber v8을 쓴다. 자세한 환경별 설정(Next.js, Expo/native 등)은 `references/getting-started-installation.mdx`.

## 핵심 규칙

1. **훅은 `<Canvas>` 안쪽 컴포넌트에서만** 쓴다. `Canvas`를 렌더하는 같은 컴포넌트에서 `useThree`를 부르면 크래시.
2. **JSX 태그는 camelCase 클래스명**: `<mesh>`, `<boxGeometry args={[1,1,1]} />`, `<meshStandardMaterial color="hotpink" />`.
   - 생성자 인자는 `args={[...]}` 배열. `args`가 바뀌면 객체가 재생성되니 고정값으로 둔다.
   - 중첩 속성은 대시로: `position-x={1}`, `material-color="red"`. 짧은 형태 `position={[x,y,z]}`도 가능.
   - `attach`로 부모의 어느 슬롯에 붙일지 지정(geometry/material은 자동). 
3. **3D 외부 클래스는 `extend`**: `extend({ OrbitControls })` 후 `<orbitControls />`, 또는 v9 팩토리형 `const Controls = extend(OrbitControls)`.
   TS에서는 `ThreeElements`를 module augmentation으로 확장.
4. **프레임마다 바뀌는 값은 setState 금지, `useFrame`에서 ref로 직접 변경**하고 `delta`를 곱한다.
5. **리소스는 공유·캐시**: geometry/material은 `useMemo`나 모듈 스코프로 공유, 반복 객체는 instancing, 에셋은 `useLoader`/`useGLTF`.
6. **마운트/언마운트 남발 금지**: 단계별 장면은 조건부 렌더 대신 `visible` 토글.
7. **루프 안에서 `new THREE.Vector3()` 등 할당 금지**: 바깥에서 만든 객체를 `.set()`으로 재사용.

## 기본 골격

```jsx
import { Canvas, useFrame } from '@react-three/fiber'
import { useRef, useState } from 'react'

function Box(props) {
  const ref = useRef()
  const [hovered, hover] = useState(false)
  useFrame((state, delta) => (ref.current.rotation.x += delta))
  return (
    <mesh {...props} ref={ref}
      onPointerOver={(e) => (e.stopPropagation(), hover(true))}
      onPointerOut={() => hover(false)}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={hovered ? 'hotpink' : 'orange'} />
    </mesh>
  )
}

export default function App() {
  return (
    <Canvas camera={{ position: [0, 0, 5], fov: 50 }}>
      <ambientLight intensity={Math.PI / 2} />
      <directionalLight position={[5, 5, 5]} />
      <Box position={[-1.2, 0, 0]} />
      <Box position={[1.2, 0, 0]} />
    </Canvas>
  )
}
```

`<Canvas>`는 부모 크기를 100% 채우므로 부모 div에 width/height를 줘야 보인다.
Canvas props(`gl`, `camera`, `shadows`, `dpr`, `frameloop`, `flat`, `linear`, `orthographic`, `raycaster`, `onCreated` 등)는 `references/API-canvas.mdx`.

## 훅

| 훅 | 용도 |
|---|---|
| `useThree(selector?)` | 렌더러·scene·camera·size·viewport·`invalidate`·`set/get` 등 상태. 셀렉터로 필요한 것만 구독 |
| `useFrame((state, delta, xrFrame) => …, priority?)` | 프레임 루프 참여. priority > 0이면 자동 렌더 직접 제어 |
| `useLoader(Loader, url \| url[], extensions?)` | Suspense 기반 로딩 + 캐시. v9부터 로더 인스턴스도 가능. `useLoader.preload`/`.clear` |
| `useGraph(object)` | 오브젝트에서 `nodes`/`materials` 맵 추출(GLTF 처리) |

`frameloop="demand"`로 두고 상태가 바뀔 때만 `invalidate()`를 호출하면 배터리·GPU를 아낀다.
상세와 `state` 전체 속성표는 `references/API-hooks.mdx`.

## 이벤트

메시에 `onClick`, `onPointerOver/Out/Move/Down/Up`, `onWheel`, `onContextMenu`, `onDoubleClick`, `onPointerMissed` 등을 붙인다.
이벤트는 레이캐스트로 겹친 객체 전부에 전파되므로 앞쪽 하나만 받으려면 `e.stopPropagation()`.
`e.point`, `e.distance`, `e.object`, `e.intersections` 등이 들어있다. 상세는 `references/API-events.mdx`, `references/tutorials-events-and-interaction.mdx`.

## 모델·텍스처

- 텍스처: `useLoader(TextureLoader, url)` 또는 drei `useTexture`. → `references/tutorials-loading-textures.mdx`
- GLTF: drei `useGLTF(url)` 또는 `useLoader(GLTFLoader, url)`; 정적 모델은 `npx gltfjsx model.glb`로 JSX 컴포넌트로 변환하면 재사용·수정이 쉽다. → `references/tutorials-loading-models.mdx`
- 로딩 UI는 `<Suspense fallback={…}>`로 감싼다(Canvas 안쪽).

## 애니메이션

`useFrame` + `THREE.MathUtils.lerp/damp`, 또는 `@react-spring/three`(`<a.mesh position-x={x} />`), framer-motion-3d.
→ `references/tutorials-basic-animations.mdx`

## 성능 체크리스트

setState를 프레임 루프에 쓰지 않았는가 / delta 사용 / geometry·material 공유 / `InstancedMesh`·drei `Instances` /
`frameloop="demand"` / `dpr={[1, 2]}` 제한 / 조건부 마운트 대신 `visible` / `useLoader` 캐시 / 불필요한 라이트·그림자 제거.
→ `references/advanced-pitfalls.mdx`, `references/advanced-scaling-performance.mdx`

## v9 / React 19 주의

- StrictMode에서 개발 중 버그가 더 잘 드러난다(이중 마운트 대비 정리 코드 필수).
- Canvas `gl` 콜백은 `(canvas)`가 아니라 생성자 props를 받는다: `gl={(props) => new WebGLRenderer(props)}`. 비동기(WebGPU)도 Promise 반환으로 지원.
- `mouse` 대신 `pointer` 사용. 마이그레이션 전체는 `references/tutorials-v9-migration-guide.mdx`.

## 테스트·타입

- 테스트: `@react-three/test-renderer`로 DOM 없이 씬 그래프를 검증 → `references/API-testing.mdx`
- TypeScript: `ThreeElements`/`ThreeElement<typeof X>` 확장 → `references/API-typescript.mdx`
- 추가 export(`events`, `createRoot`, `extend`, `applyProps`, `addEffect` 등) → `references/API-additional-exports.mdx`

## 참고 파일 목록

| 파일 | 내용 |
|---|---|
| `references/API-canvas.mdx` | Canvas props, 기본 설정, 렌더러/카메라/그림자 |
| `references/API-hooks.mdx` | useThree/useFrame/useLoader/useGraph |
| `references/API-objects.mdx` | JSX 오브젝트·props·attach·dispose·extend |
| `references/API-events.mdx` | 이벤트 시스템, 이벤트 객체 |
| `references/API-typescript.mdx`, `API-testing.mdx`, `API-additional-exports.mdx` | 타입·테스트·추가 API |
| `references/advanced-*.mdx` | 성능 함정, 스케일링 |
| `references/tutorials-*.mdx` | 동작 원리, 모델/텍스처, 애니메이션, 이벤트, v9 마이그레이션 |
| `references/getting-started-*.mdx` | 설치, 첫 장면 |

출처: https://github.com/pmndrs/react-three-fiber (MIT, `references/LICENSE-react-three-fiber`). 문서는 v9.8.1 기준 사본이므로 최신 API는 원본 확인.
