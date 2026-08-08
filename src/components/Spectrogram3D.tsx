"use client";

import { Canvas } from "@react-three/fiber";
import { Grid, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useMemo } from "react";
import * as THREE from "three";
import type { AnalysisData } from "@/types/audio";

function Surface({ analysis, currentTime, windowSeconds, depth }: { analysis: AnalysisData; currentTime: number; windowSeconds: number; depth: number }) {
  const geometry = useMemo(() => {
    const frequencySteps = 36, timeSteps = 96;
    const half = windowSeconds / 2;
    const first = Math.max(0, Math.floor(((currentTime - half) / analysis.duration) * analysis.columns));
    const last = Math.min(analysis.columns - 1, Math.ceil(((currentTime + half) / analysis.duration) * analysis.columns));
    const vertices = new Float32Array(timeSteps * frequencySteps * 3);
    const colors = new Float32Array(timeSteps * frequencySteps * 3);
    const indices: number[] = [];
    const color = new THREE.Color();
    for (let x = 0; x < timeSteps; x++) {
      const column = Math.round(first + (last - first) * x / (timeSteps - 1));
      for (let y = 0; y < frequencySteps; y++) {
        const band = Math.floor(y / (frequencySteps - 1) * (analysis.bands - 1));
        const power = analysis.spectral[column * analysis.bands + band] / 255;
        const index = (x * frequencySteps + y) * 3;
        vertices[index] = (x / (timeSteps - 1) - 0.5) * 12;
        vertices[index + 1] = power * depth * 3.2 - 1.25;
        vertices[index + 2] = (y / (frequencySteps - 1) - 0.5) * -7;
        color.setHSL(0.58 - power * 0.48, 0.9, 0.18 + power * 0.52);
        colors.set([color.r, color.g, color.b], index);
        if (x < timeSteps - 1 && y < frequencySteps - 1) {
          const a = x * frequencySteps + y, b = a + frequencySteps, c = b + 1, d = a + 1;
          indices.push(a, b, d, b, c, d);
        }
      }
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    result.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    result.setIndex(indices); result.computeVertexNormals();
    return result;
  }, [analysis, currentTime, windowSeconds, depth]);
  return <mesh geometry={geometry}><meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.7} metalness={0.12} /></mesh>;
}

export function Spectrogram3D(props: { analysis: AnalysisData | null; currentTime: number; windowSeconds: number; depth: number }) {
  return <div className="three-stage" aria-label="Interactive 3D spectrogram">
    {!props.analysis && <div className="empty-visual"><div className="empty-rings"/><span>SPECTRAL FIELD STANDBY</span><p>Load a recording to construct the frequency surface</p></div>}
    {props.analysis && <Canvas dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: "high-performance" }}>
      <color attach="background" args={["#07100f"]}/><fog attach="fog" args={["#07100f", 8, 22]}/>
      <PerspectiveCamera makeDefault position={[8.4, 6.5, 9.4]} fov={45}/>
      <ambientLight intensity={0.65}/><directionalLight position={[2, 8, 4]} intensity={2.2} color="#85ffe4"/>
      <Surface {...props} analysis={props.analysis}/>
      <mesh position={[0, 1.1, 0]}><boxGeometry args={[0.035, 5, 7.1]}/><meshBasicMaterial color="#f5bb45" transparent opacity={0.9}/></mesh>
      <Grid args={[14, 10]} position={[0, -1.3, 0]} cellColor="#173f39" sectionColor="#2c776b" fadeDistance={18} infiniteGrid/>
      <OrbitControls enableDamping dampingFactor={0.08} minDistance={5} maxDistance={22} maxPolarAngle={Math.PI / 2.08}/>
    </Canvas>}
    <div className="axis axis-time">TIME</div><div className="axis axis-frequency">FREQUENCY</div><div className="axis axis-db">INTENSITY</div>
    <div className="gesture-hint">Drag to orbit · Pinch to zoom</div>
  </div>;
}
