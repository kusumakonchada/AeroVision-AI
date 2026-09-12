import React, { useEffect, useRef, useState, useCallback } from 'react';
import { 
  Camera, 
  Cpu, 
  Play, 
  Square,
  Maximize2,
  Sliders,
  RotateCcw,
  Radio,
  Compass,
  ArrowLeftRight,
  ArrowUp,
  ShieldAlert,
  Zap,
  Activity
} from 'lucide-react';
import { motion } from 'motion/react';
import { FilesetResolver, ObjectDetector, Detection } from '@mediapipe/tasks-vision';
import { cn } from './lib/utils';

// --- Constants ---
const DETECTION_THRESHOLD = 0.45;
const MODEL_ASSET_PATH = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

type Zone = 'LEFT' | 'CENTER' | 'RIGHT' | 'NONE';

interface FlightLog {
  id: string;
  time: string;
  zone: Zone;
  command: string;
  label: string;
}

export default function App() {
  const [detector, setDetector] = useState<ObjectDetector | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(true);
  const [droneState, setDroneState] = useState<{ x: number; y: number; roll: number; status: string }>({ 
    x: 50, 
    y: 50, 
    roll: 0, 
    status: 'READY' 
  });
  const [currentZone, setCurrentZone] = useState<Zone>('NONE');
  const [detection, setDetection] = useState<Detection | null>(null);
  const [fps, setFps] = useState<number>(0);
  const [flightLogs, setFlightLogs] = useState<FlightLog[]>([]);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(1.2);
  const [controlMode, setControlMode] = useState<'avoid' | 'follow'>('avoid'); // Avoid: Left->Move Right, Follow: Left->Move Left

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(performance.now());
  const frameCountRef = useRef<number>(0);
  const lastLogTimeRef = useRef<number>(0);

  // Initialize MediaPipe Object Detector
  useEffect(() => {
    async function initDetector() {
      try {
        setIsModelLoading(true);
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );
        const objectDetector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: 'GPU'
          },
          scoreThreshold: DETECTION_THRESHOLD,
          runningMode: 'VIDEO'
        });
        setDetector(objectDetector);
        setIsModelLoading(false);
      } catch (error) {
        console.error("Failed to initialize object detector:", error);
        setIsModelLoading(false);
      }
    }
    initDetector();
  }, []);

  // Handle Camera stream toggle
  const toggleCamera = async () => {
    if (isCameraActive) {
      if (videoRef.current?.srcObject) {
        const tracks = (videoRef.current.srcObject as MediaStream).getTracks();
        tracks.forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }
      setIsCameraActive(false);
      setDetection(null);
      setCurrentZone('NONE');
      setDroneState(prev => ({ ...prev, roll: 0, status: 'STANDBY' }));
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            width: { ideal: 640 }, 
            height: { ideal: 480 },
            facingMode: 'user'
          } 
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play();
            setIsCameraActive(true);
            setDroneState(prev => ({ ...prev, status: 'STABLE' }));
          };
        }
      } catch (err) {
        console.error('Error accessing camera:', err);
      }
    }
  };

  const resetDronePosition = useCallback(() => {
    setDroneState({ x: 50, y: 50, roll: 0, status: 'STABLE' });
  }, []);

  // Detection and Drone Control Loop
  useEffect(() => {
    if (!isCameraActive || !detector || !videoRef.current) return;

    const detect = () => {
      const now = performance.now();
      frameCountRef.current++;
      if (now - lastTimeRef.current >= 1000) {
        setFps(frameCountRef.current);
        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }

      if (videoRef.current && videoRef.current.readyState >= 2) {
        const startTimeMs = performance.now();
        const results = detector.detectForVideo(videoRef.current, startTimeMs);
        
        if (results.detections.length > 0) {
          const bestDetection = results.detections[0];
          setDetection(bestDetection);

          const box = bestDetection.boundingBox;
          if (box) {
            const videoWidth = videoRef.current.videoWidth || 640;
            // Mirrored display: user screen left corresponds to (1 - normalized raw x)
            const rawCenterX = (box.originX + box.width / 2) / videoWidth;
            const screenCenterX = 1 - rawCenterX;
            
            let detectedZone: Zone = 'CENTER';
            let status = 'STABLE';
            let moveX = 0;
            let moveY = 0;
            let targetRoll = 0;

            if (screenCenterX < 0.35) {
              detectedZone = 'LEFT';
              if (controlMode === 'avoid') {
                // Object on screen LEFT -> Drone moves RIGHT
                status = 'EVADING RIGHT';
                moveX = 1.2 * speedMultiplier;
                targetRoll = 18;
              } else {
                status = 'TRACKING LEFT';
                moveX = -1.2 * speedMultiplier;
                targetRoll = -18;
              }
            } else if (screenCenterX > 0.65) {
              detectedZone = 'RIGHT';
              if (controlMode === 'avoid') {
                // Object on screen RIGHT -> Drone moves LEFT
                status = 'EVADING LEFT';
                moveX = -1.2 * speedMultiplier;
                targetRoll = -18;
              } else {
                status = 'TRACKING RIGHT';
                moveX = 1.2 * speedMultiplier;
                targetRoll = 18;
              }
            } else {
              detectedZone = 'CENTER';
              // Object in CENTER -> Stay stable or move UP
              status = 'CENTER / CLIMB UP';
              moveY = -0.5 * speedMultiplier;
              targetRoll = 0;
            }

            setCurrentZone(detectedZone);

            setDroneState(prev => ({
              x: Math.max(12, Math.min(88, prev.x + moveX)),
              y: Math.max(12, Math.min(88, prev.y + moveY)),
              roll: targetRoll,
              status
            }));

            // Throttle flight logs to 1 per second
            if (now - lastLogTimeRef.current > 900) {
              const categoryName = bestDetection.categories[0]?.categoryName || 'Object';
              setFlightLogs(prevLogs => [
                {
                  id: Math.random().toString(36).substring(2, 7),
                  time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                  zone: detectedZone,
                  command: status,
                  label: categoryName
                },
                ...prevLogs.slice(0, 5)
              ]);
              lastLogTimeRef.current = now;
            }
          }
        } else {
          setDetection(null);
          setCurrentZone('NONE');
          setDroneState(prev => ({ 
            ...prev, 
            roll: 0, 
            status: 'HOVERING (SEARCHING)' 
          }));
        }

        // Draw HUD bounding box on mirrored canvas
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext('2d');
          if (ctx) {
            ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
            if (results.detections.length > 0) {
              const box = results.detections[0].boundingBox!;
              const label = results.detections[0].categories[0]?.categoryName || 'Target';
              const score = Math.round((results.detections[0].categories[0]?.score || 0) * 100);

              // Target box styling
              ctx.strokeStyle = '#38bdf8';
              ctx.lineWidth = 3;
              ctx.setLineDash([8, 4]);
              ctx.strokeRect(box.originX, box.originY, box.width, box.height);
              
              // Target corners
              ctx.lineWidth = 4;
              ctx.setLineDash([]);
              const cornerLen = 14;
              // Top-left
              ctx.beginPath();
              ctx.moveTo(box.originX, box.originY + cornerLen);
              ctx.lineTo(box.originX, box.originY);
              ctx.lineTo(box.originX + cornerLen, box.originY);
              ctx.stroke();

              // Center crosshair
              const cx = box.originX + box.width / 2;
              const cy = box.originY + box.height / 2;
              ctx.strokeStyle = '#f43f5e';
              ctx.beginPath();
              ctx.arc(cx, cy, 6, 0, Math.PI * 2);
              ctx.stroke();

              // Badge
              ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
              ctx.fillRect(box.originX, Math.max(0, box.originY - 26), 130, 24);
              ctx.fillStyle = '#38bdf8';
              ctx.font = 'bold 12px ui-monospace, monospace';
              ctx.fillText(`${label.toUpperCase()} ${score}%`, box.originX + 6, Math.max(16, box.originY - 8));
            }
          }
        }
      }
      requestRef.current = requestAnimationFrame(detect);
    };

    requestRef.current = requestAnimationFrame(detect);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isCameraActive, detector, speedMultiplier, controlMode]);

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 font-sans selection:bg-cyan-500/30">
      {/* Top Header */}
      <header id="main-header" className="border-b border-slate-800/80 bg-[#0a0d14]/90 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Radio className="text-white w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-white">AeroVision AI</h1>
                <span className="px-2 py-0.5 text-[10px] font-mono uppercase font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 rounded-md">
                  Autonomous CV
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono tracking-wide leading-tight">
                Computer Vision Virtual Drone Guidance System
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-slate-900/80 border border-slate-800 rounded-lg text-xs font-mono text-slate-300">
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              <span>FPS: {isCameraActive ? fps : '--'}</span>
            </div>

            <div className={cn(
              "flex items-center gap-2 px-3 py-1 border rounded-lg text-xs font-mono font-medium transition-all",
              isCameraActive 
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                : "bg-amber-500/10 border-amber-500/30 text-amber-300"
            )}>
              <span className={cn(
                "w-2 h-2 rounded-full",
                isCameraActive ? "bg-emerald-400 animate-ping" : "bg-amber-400"
              )} />
              <span>{isCameraActive ? "VISION ACTIVE" : "VISION IDLE"}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div className="grid lg:grid-cols-12 gap-6">
          {/* Left Column: Webcam Input & Computer Vision Tracking (7 cols) */}
          <div className="lg:col-span-12 xl:col-span-7 space-y-4">
            <div className="bg-[#0e121b] rounded-2xl border border-slate-800/80 p-4 shadow-xl relative overflow-hidden">
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                  <Camera className="w-4 h-4 text-cyan-400" />
                  <h2 className="text-sm font-semibold tracking-wide text-slate-200">Vision Tracking Input</h2>
                </div>
                <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400">
                  <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                  <span>EfficientDet-Lite0</span>
                </div>
              </div>

              {/* Video Frame */}
              <div className="relative aspect-video rounded-xl overflow-hidden border border-slate-800 bg-slate-950 flex items-center justify-center group">
                {!isCameraActive && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 backdrop-blur-sm z-20 px-6 text-center">
                    <div className="p-4 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 mb-4 text-cyan-400">
                      <Camera className="w-8 h-8" />
                    </div>
                    <h3 className="text-base font-semibold text-white mb-1">Webcam Input Ready</h3>
                    <p className="text-xs text-slate-400 max-w-sm mb-6 leading-relaxed">
                      Enable your camera to track your position in real-time. Objects detected in your camera feed directly command the virtual drone.
                    </p>
                    <button 
                      id="enable-camera-button"
                      onClick={toggleCamera}
                      disabled={isModelLoading}
                      className="flex items-center gap-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-medium text-sm px-6 py-3 rounded-xl transition-all shadow-lg shadow-cyan-500/25 active:scale-95 disabled:opacity-50"
                    >
                      {isModelLoading ? (
                        <>
                          <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          <span>Initializing AI Vision...</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 fill-current" />
                          <span>Start Camera Vision</span>
                        </>
                      )}
                    </button>
                  </div>
                )}

                <video 
                  ref={videoRef}
                  className="w-full h-full object-cover scale-x-[-1]"
                  playsInline
                  muted
                />
                <canvas 
                  ref={canvasRef}
                  className="absolute inset-0 w-full h-full pointer-events-none scale-x-[-1]"
                  width={640}
                  height={480}
                />

                {/* Real-time Visual 3-Zone Overlay (LEFT / CENTER / RIGHT) */}
                <div className="absolute inset-0 pointer-events-none grid grid-cols-3 z-10">
                  {/* Left Screen Zone */}
                  <div className={cn(
                    "border-r border-dashed transition-colors flex flex-col justify-between p-3",
                    currentZone === 'LEFT'
                      ? "border-cyan-400/80 bg-cyan-500/10"
                      : "border-slate-700/40 bg-transparent"
                  )}>
                    <div className="flex items-center gap-1.5">
                      <span className={cn(
                        "text-[10px] font-mono font-bold px-2 py-0.5 rounded",
                        currentZone === 'LEFT' ? "bg-cyan-500 text-slate-950 font-bold" : "bg-slate-900/80 text-slate-400 border border-slate-800"
                      )}>
                        LEFT ZONE
                      </span>
                    </div>
                    {currentZone === 'LEFT' && (
                      <div className="text-[11px] font-mono text-cyan-300 font-semibold bg-slate-950/80 px-2 py-1 rounded w-fit border border-cyan-500/30 animate-pulse">
                        COMMAND: MOVE RIGHT ➔
                      </div>
                    )}
                  </div>

                  {/* Center Screen Zone */}
                  <div className={cn(
                    "border-r border-dashed transition-colors flex flex-col justify-between p-3",
                    currentZone === 'CENTER'
                      ? "border-emerald-400/80 bg-emerald-500/10"
                      : "border-slate-700/40 bg-transparent"
                  )}>
                    <div className="flex items-center justify-center">
                      <span className={cn(
                        "text-[10px] font-mono font-bold px-2 py-0.5 rounded",
                        currentZone === 'CENTER' ? "bg-emerald-500 text-slate-950 font-bold" : "bg-slate-900/80 text-slate-400 border border-slate-800"
                      )}>
                        CENTER ZONE
                      </span>
                    </div>
                    {currentZone === 'CENTER' && (
                      <div className="text-[11px] font-mono text-emerald-300 font-semibold bg-slate-950/80 px-2 py-1 rounded w-fit mx-auto border border-emerald-500/30 animate-pulse">
                        COMMAND: HOVER / CLIMB ▲
                      </div>
                    )}
                  </div>

                  {/* Right Screen Zone */}
                  <div className={cn(
                    "transition-colors flex flex-col justify-between p-3",
                    currentZone === 'RIGHT'
                      ? "bg-cyan-500/10 border-l border-cyan-400/80"
                      : "bg-transparent"
                  )}>
                    <div className="flex items-center justify-end">
                      <span className={cn(
                        "text-[10px] font-mono font-bold px-2 py-0.5 rounded",
                        currentZone === 'RIGHT' ? "bg-cyan-500 text-slate-950 font-bold" : "bg-slate-900/80 text-slate-400 border border-slate-800"
                      )}>
                        RIGHT ZONE
                      </span>
                    </div>
                    {currentZone === 'RIGHT' && (
                      <div className="text-[11px] font-mono text-cyan-300 font-semibold bg-slate-950/80 px-2 py-1 rounded w-fit ml-auto border border-cyan-500/30 animate-pulse">
                        ➔ COMMAND: MOVE LEFT
                      </div>
                    )}
                  </div>
                </div>

                {/* Camera control button */}
                {isCameraActive && (
                  <div className="absolute top-3 right-3 z-30 flex items-center gap-2">
                    <button 
                      id="stop-camera-button"
                      onClick={toggleCamera}
                      className="p-2 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 backdrop-blur-md transition-all text-xs font-mono flex items-center gap-1.5"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Stop Feed</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Status & Telemetry Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3">
                  <div className="text-[10px] font-mono uppercase text-slate-400 flex items-center gap-1.5">
                    <ShieldAlert className="w-3 h-3 text-cyan-400" />
                    <span>Flight Action</span>
                  </div>
                  <div className="text-xs sm:text-sm font-mono font-bold text-cyan-300 mt-1 truncate">
                    {droneState.status}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3">
                  <div className="text-[10px] font-mono uppercase text-slate-400 flex items-center gap-1.5">
                    <Maximize2 className="w-3 h-3 text-emerald-400" />
                    <span>Target Lock</span>
                  </div>
                  <div className={cn(
                    "text-xs sm:text-sm font-mono font-bold mt-1",
                    detection ? "text-emerald-400" : "text-slate-500"
                  )}>
                    {detection ? (detection.categories[0]?.categoryName.toUpperCase() || 'LOCKED') : 'SEARCHING'}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3">
                  <div className="text-[10px] font-mono uppercase text-slate-400 flex items-center gap-1.5">
                    <Compass className="w-3 h-3 text-purple-400" />
                    <span>Position Zone</span>
                  </div>
                  <div className="text-xs sm:text-sm font-mono font-bold text-purple-300 mt-1">
                    {currentZone}
                  </div>
                </div>

                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3">
                  <div className="text-[10px] font-mono uppercase text-slate-400 flex items-center gap-1.5">
                    <Zap className="w-3 h-3 text-amber-400" />
                    <span>Altitude</span>
                  </div>
                  <div className="text-xs sm:text-sm font-mono font-bold text-amber-300 mt-1">
                    {(100 - droneState.y).toFixed(1)}m
                  </div>
                </div>
              </div>
            </div>

            {/* Flight Rules Reference Card */}
            <div className="bg-[#0e121b] rounded-2xl border border-slate-800/80 p-4 shadow-xl">
              <div className="text-xs font-mono text-slate-400 uppercase font-semibold mb-3 flex items-center gap-2">
                <ArrowLeftRight className="w-4 h-4 text-cyan-400" />
                <span>Simulated Drone Logic Rules</span>
              </div>
              <div className="grid sm:grid-cols-3 gap-3 text-xs">
                <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">
                  <div className="font-semibold text-cyan-400 mb-1 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-cyan-400" />
                    LEFT ZONE
                  </div>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    Object detected on left: drone banking right (<span className="text-white font-mono font-medium">MOVE RIGHT</span>) to maintain safety distance.
                  </p>
                </div>

                <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">
                  <div className="font-semibold text-emerald-400 mb-1 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    CENTER ZONE
                  </div>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    Object centered: drone holds horizontal position and ascends (<span className="text-white font-mono font-medium">MOVE UP / HOVER</span>).
                  </p>
                </div>

                <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800/80">
                  <div className="font-semibold text-cyan-400 mb-1 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-cyan-400" />
                    RIGHT ZONE
                  </div>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    Object detected on right: drone moves left (<span className="text-white font-mono font-medium">MOVE LEFT</span>) to avoid obstacle trajectory.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Virtual Drone 2D Flight Arena (5 cols) */}
          <div className="lg:col-span-12 xl:col-span-5 space-y-4">
            <div className="bg-[#0e121b] rounded-2xl border border-slate-800/80 p-4 shadow-xl flex flex-col h-full min-h-[460px]">
              <div className="flex items-center justify-between mb-3 px-1">
                <div>
                  <h2 className="text-sm font-semibold tracking-wide text-slate-200">Virtual Flight Simulator</h2>
                  <p className="text-[11px] text-slate-400 font-mono">Real-time Reactive Flight Grid</p>
                </div>
                <button
                  id="reset-drone-button"
                  onClick={resetDronePosition}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs font-mono bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition-colors border border-slate-700"
                  title="Recenter Drone"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Recenter</span>
                </button>
              </div>

              {/* 2D Drone Flight Arena */}
              <div className="flex-1 relative bg-slate-950 rounded-xl border border-slate-800/90 overflow-hidden min-h-[300px] flex items-center justify-center shadow-inner">
                {/* Visual Grid Lines */}
                <div className="absolute inset-0 bg-[linear-gradient(to_right,#1e293b18_1px,transparent_1px),linear-gradient(to_bottom,#1e293b18_1px,transparent_1px)] bg-[size:28px_28px]" />
                
                {/* Safe zone boundary */}
                <div className="absolute inset-4 border border-dashed border-slate-800 rounded-lg pointer-events-none" />
                
                {/* Center crosshair */}
                <div className="absolute inset-x-0 top-1/2 h-px bg-cyan-500/20" />
                <div className="absolute inset-y-0 left-1/2 w-px bg-cyan-500/20" />

                {/* Simulated Drone Unit */}
                <motion.div 
                  className="absolute w-20 h-20 -ml-10 -mt-10 pointer-events-none z-10"
                  animate={{ 
                    left: `${droneState.x}%`, 
                    top: `${droneState.y}%`,
                    rotate: droneState.roll,
                  }}
                  transition={{ type: 'spring', damping: 18, stiffness: 70 }}
                >
                  <div className="relative w-full h-full flex items-center justify-center">
                    {/* Shadow underneath */}
                    <div className="absolute -bottom-6 w-12 h-3 bg-black/70 blur-md rounded-full" />
                    
                    {/* Drone Body Frame */}
                    <svg viewBox="0 0 100 100" className="w-full h-full drop-shadow-[0_0_15px_rgba(6,182,212,0.6)]">
                      {/* Cross arms */}
                      <line x1="20" y1="20" x2="80" y2="80" stroke="#0ea5e9" strokeWidth="6" strokeLinecap="round" />
                      <line x1="80" y1="20" x2="20" y2="80" stroke="#0ea5e9" strokeWidth="6" strokeLinecap="round" />
                      
                      {/* Center Chassis */}
                      <circle cx="50" cy="50" r="16" fill="#0f172a" stroke="#38bdf8" strokeWidth="3" />
                      <circle cx="50" cy="50" r="6" fill="#38bdf8" />
                      
                      {/* 4 Rotors with spinning effect */}
                      <g className="animate-spin" style={{ transformOrigin: '20px 20px', animationDuration: '0.2s' }}>
                        <circle cx="20" cy="20" r="12" fill="none" stroke="#67e8f9" strokeWidth="2" strokeDasharray="6,4" />
                        <circle cx="20" cy="20" r="3" fill="#38bdf8" />
                      </g>
                      <g className="animate-spin" style={{ transformOrigin: '80px 20px', animationDuration: '0.2s' }}>
                        <circle cx="80" cy="20" r="12" fill="none" stroke="#67e8f9" strokeWidth="2" strokeDasharray="6,4" />
                        <circle cx="80" cy="20" r="3" fill="#38bdf8" />
                      </g>
                      <g className="animate-spin" style={{ transformOrigin: '20px 80px', animationDuration: '0.2s' }}>
                        <circle cx="20" cy="80" r="12" fill="none" stroke="#67e8f9" strokeWidth="2" strokeDasharray="6,4" />
                        <circle cx="20" cy="80" r="3" fill="#38bdf8" />
                      </g>
                      <g className="animate-spin" style={{ transformOrigin: '80px 80px', animationDuration: '0.2s' }}>
                        <circle cx="80" cy="80" r="12" fill="none" stroke="#67e8f9" strokeWidth="2" strokeDasharray="6,4" />
                        <circle cx="80" cy="80" r="3" fill="#38bdf8" />
                      </g>

                      {/* Direction LED */}
                      <polygon points="50,30 45,38 55,38" fill="#f43f5e" />
                    </svg>

                    {/* Vector Heading tag */}
                    <div className="absolute -top-6 whitespace-nowrap bg-slate-900/90 border border-cyan-500/40 text-cyan-300 font-mono text-[9px] px-2 py-0.5 rounded shadow">
                      X: {droneState.x.toFixed(0)} | Y: {(100 - droneState.y).toFixed(0)}
                    </div>
                  </div>
                </motion.div>

                {/* Real-time flight telemetry readout overlay */}
                <div className="absolute bottom-3 left-3 bg-slate-900/80 border border-slate-800 backdrop-blur-sm rounded-lg p-2 font-mono text-[10px] space-y-0.5 text-slate-400">
                  <div>ROLL: <span className="text-cyan-400">{droneState.roll}°</span></div>
                  <div>ALT: <span className="text-amber-400">{(100 - droneState.y).toFixed(1)} m</span></div>
                  <div>STATUS: <span className="text-emerald-400">{droneState.status}</span></div>
                </div>
              </div>

              {/* Controls & Configuration */}
              <div className="mt-4 pt-4 border-t border-slate-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                    <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                    Reaction Sensitivity
                  </span>
                  <span className="text-xs font-mono font-bold text-cyan-400">{speedMultiplier.toFixed(1)}x</span>
                </div>
                <input 
                  type="range" 
                  min="0.5" 
                  max="2.5" 
                  step="0.1" 
                  value={speedMultiplier} 
                  onChange={(e) => setSpeedMultiplier(parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                />

                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs font-mono text-slate-400">Control Mode:</span>
                  <div className="flex gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800 text-xs">
                    <button
                      onClick={() => setControlMode('avoid')}
                      className={cn(
                        "px-2.5 py-1 rounded font-mono text-[11px] transition-colors",
                        controlMode === 'avoid' ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold" : "text-slate-400 hover:text-slate-200"
                      )}
                    >
                      Collision Avoidance
                    </button>
                    <button
                      onClick={() => setControlMode('follow')}
                      className={cn(
                        "px-2.5 py-1 rounded font-mono text-[11px] transition-colors",
                        controlMode === 'follow' ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-semibold" : "text-slate-400 hover:text-slate-200"
                      )}
                    >
                      Object Tracking
                    </button>
                  </div>
                </div>
              </div>

              {/* Live Flight Command Log Ticker */}
              <div className="mt-4 pt-3 border-t border-slate-800">
                <div className="text-[11px] font-mono text-slate-400 uppercase font-semibold mb-2 flex items-center justify-between">
                  <span>Live Command Stream</span>
                  <span className="text-[10px] text-slate-500">Auto-logged</span>
                </div>
                <div className="space-y-1 max-h-24 overflow-y-auto font-mono text-[11px]">
                  {flightLogs.length === 0 ? (
                    <div className="text-slate-600 italic py-2 text-center text-xs">
                      Awaiting camera detection events...
                    </div>
                  ) : (
                    flightLogs.map(log => (
                      <div key={log.id} className="flex items-center justify-between p-1.5 rounded bg-slate-900/60 border border-slate-800/60 text-slate-300">
                        <div className="flex items-center gap-2">
                          <span className="text-slate-500 text-[10px]">{log.time}</span>
                          <span className="text-cyan-400 font-semibold">{log.label}</span>
                          <span className="text-slate-400">[{log.zone}]</span>
                        </div>
                        <span className={cn(
                          "text-[10px] font-bold px-1.5 py-0.5 rounded",
                          log.zone === 'LEFT' ? "bg-cyan-500/20 text-cyan-300" :
                          log.zone === 'RIGHT' ? "bg-blue-500/20 text-blue-300" :
                          "bg-emerald-500/20 text-emerald-300"
                        )}>
                          {log.command}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
