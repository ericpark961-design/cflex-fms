import * as THREE from 'three';
export function buildDemoScene(canvas, opts){

const ROOM={w:14,d:12.7,h:3.0};
const C={ok:0x1c4f8a,hot:0x08bdba,warn:0xf1c21b,crit:0xfa4d56,empty:0x2b2b2b,floor:0x111418,wall:0x1a1f27,crac:0x42be65,ups:0x4589ff,text:'#f4f4f4'};

const renderer=new THREE.WebGLRenderer({canvas,antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true; renderer.shadowMap.type=THREE.PCFSoftShadowMap;
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x070a10); scene.fog=new THREE.Fog(0x070a10,30,70);
const camera=new THREE.PerspectiveCamera(45,1,0.1,200);
// ---------- lights
scene.add(new THREE.HemisphereLight(0x8fb3ff,0x101418,0.55));
const sun=new THREE.DirectionalLight(0xffffff,1.1); sun.position.set(10,14,8); sun.castShadow=true;
sun.shadow.mapSize.set(2048,2048); Object.assign(sun.shadow.camera,{left:-14,right:14,top:14,bottom:-14,near:1,far:50}); scene.add(sun);
const fill=new THREE.PointLight(0x4589ff,0.6,30); fill.position.set(-6,4,6); scene.add(fill);
// ---------- room
const floorGeo=new THREE.PlaneGeometry(ROOM.w,ROOM.d,70,64); floorGeo.rotateX(-Math.PI/2);
const floorMat=new THREE.MeshStandardMaterial({color:0xffffff,roughness:0.9,metalness:0.05,vertexColors:true});
const floor=new THREE.Mesh(floorGeo,floorMat); floor.receiveShadow=true; scene.add(floor);
const grid=new THREE.GridHelper(Math.max(ROOM.w,ROOM.d),Math.round(Math.max(ROOM.w,ROOM.d)/0.6),0x2a3140,0x1c2230); grid.position.y=0.005; scene.add(grid);
const wallMat=new THREE.MeshStandardMaterial({color:C.wall,roughness:0.95,transparent:true,opacity:0.55,side:THREE.DoubleSide});
function wall(w,h,x,y,z,ry){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),wallMat);m.position.set(x,y,z);m.rotation.y=ry;scene.add(m);}
wall(ROOM.w,ROOM.h,0,ROOM.h/2,-ROOM.d/2,0); wall(ROOM.d,ROOM.h,-ROOM.w/2,ROOM.h/2,0,Math.PI/2);
const edges=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(ROOM.w,ROOM.h,ROOM.d)),new THREE.LineBasicMaterial({color:0x3a4356})); edges.position.y=ROOM.h/2; scene.add(edges);
// ---------- text sprite
function label(text,size,color){const cv=document.createElement('canvas');const ctx=cv.getContext('2d');const f=`600 ${size*8}px "IBM Plex Sans KR","Noto Sans CJK KR",sans-serif`;ctx.font=f;const w=Math.ceil(ctx.measureText(text).width)+24;cv.width=w;cv.height=size*8+16;ctx.font=f;ctx.fillStyle='rgba(11,11,11,.75)';ctx.fillRect(0,0,cv.width,cv.height);ctx.fillStyle=color||C.text;ctx.textBaseline='middle';ctx.fillText(text,12,cv.height/2);const t=new THREE.CanvasTexture(cv);t.minFilter=THREE.LinearFilter;const s=new THREE.Sprite(new THREE.SpriteMaterial({map:t,depthTest:false,transparent:true}));s.scale.set(cv.width/160*size/2,cv.height/160*size/2,1);return s;}
// ---------- racks
const rowSpec=[11,11,10,10,10,10]; // 62
const rackW=0.6,rackD=1.2,rackH=2.0;
const racks=[]; const rackGroup=new THREE.Group(); scene.add(rackGroup);
const special={ 'B07':{kw:6.4,temp:27.9,st:'crit'}, 'B02':{kw:4.3,temp:25.1,st:'hot'}, 'A04':{kw:4.8,temp:25.4,st:'hot'}, 'C01':{kw:3.9,temp:26.3,st:'warn'}, 'C03':{kw:3.6,temp:26.1,st:'warn'}, 'D05':{kw:4.6,temp:24.9,st:'hot'},'D06':{kw:4.1,temp:24.7,st:'hot'}, 'F03':{kw:4.2,temp:24.4,st:'hot'} };
const empties=new Set(['A09','A10','C10','E09','E10','F07','F08','F09','F10']);
let seed=7; const rnd=()=>{seed=(seed*9301+49297)%233280;return seed/233280;};
const rowNames='ABCDEF';
let z=-ROOM.d/2+1.9;
rowSpec.forEach((n,ri)=>{
  const rowLen=n*(rackW+0.02); let x=-rowLen/2+rackW/2+(ri%2?0.3:0);
  const hotSide=ri%2===0; // alternate hot/cold aisle facing
  for(let i=0;i<n;i++){
    const id=rowNames[ri]+String(i+1).padStart(2,'0');
    const sp=special[id]; const empty=empties.has(id);
    const kw=empty?0:(sp?sp.kw:+(0.6+rnd()*2.4).toFixed(1));
    const temp=empty?23.0:(sp?sp.temp:+(22.8+rnd()*1.8).toFixed(1));
    const st=empty?'empty':(sp?sp.st:'ok');
    const geo=new THREE.BoxGeometry(rackW,rackH,rackD);
    const mat=new THREE.MeshStandardMaterial({color:C[st],roughness:0.55,metalness:0.25,emissive:0x000000});
    const m=new THREE.Mesh(geo,mat); m.position.set(x,rackH/2,z); m.castShadow=true; m.receiveShadow=true;
    // front panel stripe (LED bar)
    const led=new THREE.Mesh(new THREE.BoxGeometry(rackW*0.8,0.03,0.02),new THREE.MeshBasicMaterial({color:st==='empty'?0x333333:(st==='crit'?0xff8389:0x7ad7ff)}));
    led.position.set(0,rackH*0.42,(hotSide?1:-1)*(rackD/2+0.011)); m.add(led);
    m.userData={id,row:rowNames[ri],kw,temp,st,empty,base:C[st]};
    rackGroup.add(m); racks.push(m); x+=rackW+0.02;
  }
  const lab=label(`${rowNames[ri]}열 · ${n}랙`,2.2,'#c6c6c6'); lab.position.set(-rowLen/2-0.9,0.9,z); scene.add(lab);
  z+= rackD + (ri%2===0?1.2:1.0);
});
// ---------- CRAC x3 along north wall
const cracs=[]; const cracSpec=[{id:'CRAC-1',rt:30,fan:72,st:'ok',x:-4.6},{id:'CRAC-2',rt:30,fan:68,st:'warn',x:0},{id:'CRAC-3',rt:20,fan:70,st:'ok',x:4.6}];
cracSpec.forEach(s=>{const m=new THREE.Mesh(new THREE.BoxGeometry(1.4,2.0,0.9),new THREE.MeshStandardMaterial({color:s.st==='warn'?C.warn:C.crac,roughness:0.5,metalness:0.3}));m.position.set(s.x,1.0,-ROOM.d/2+0.5);m.castShadow=true;m.userData={id:s.id,kind:'CRAC',rt:s.rt,fan:s.fan,st:s.st};scene.add(m);cracs.push(m);
 const grill=new THREE.Mesh(new THREE.PlaneGeometry(1.2,0.8),new THREE.MeshBasicMaterial({color:0x0b0b0b}));grill.position.set(0,0.3,0.451);m.add(grill);
 const lab=label(`${s.id} · ${s.rt}RT · 팬 ${s.fan}%`,2.4,s.st==='warn'?'#f1c21b':'#42be65');lab.position.set(s.x,2.5,-ROOM.d/2+0.5);scene.add(lab);});
// ---------- UPS x2 east wall + FM-200
const upsSpec=[{id:'UPS-1',load:48,z:-3.0},{id:'UPS-2',load:44,z:-1.6}]; const upsMeshes=[];
upsSpec.forEach(s=>{const m=new THREE.Mesh(new THREE.BoxGeometry(0.9,1.9,0.9),new THREE.MeshStandardMaterial({color:C.ups,roughness:0.5,metalness:0.3}));m.position.set(ROOM.w/2-0.6,0.95,s.z);m.castShadow=true;m.userData={id:s.id,kind:'UPS',load:s.load};scene.add(m);upsMeshes.push(m);const lab=label(`${s.id} · 부하 ${s.load}%`,2.2,'#a6c8ff');lab.position.set(ROOM.w/2-0.6,2.3,s.z);scene.add(lab);});
for(let i=0;i<3;i++){const cyl=new THREE.Mesh(new THREE.CylinderGeometry(0.18,0.18,1.4,20),new THREE.MeshStandardMaterial({color:0xb81921,roughness:0.4,metalness:0.5}));cyl.position.set(ROOM.w/2-0.5,0.7,2.2+i*0.45);cyl.castShadow=true;scene.add(cyl);}
const fmLab=label('FM-200 · 정상',2.0,'#c6c6c6');fmLab.position.set(ROOM.w/2-0.5,1.9,2.7);scene.add(fmLab);
// ---------- sensors: 6 T/H posts, 3 smoke
const sensors=[];const sensorPos=[[-5,-3.2],[0,-3.2],[5,-3.2],[-5,3.2],[0,3.2],[5,3.2]];
sensorPos.forEach((p,i)=>{const post=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.02,1.5,8),new THREE.MeshStandardMaterial({color:0x8d8d8d}));post.position.set(p[0],0.75,p[1]);scene.add(post);const ball=new THREE.Mesh(new THREE.SphereGeometry(0.09,16,16),new THREE.MeshStandardMaterial({color:0x78a9ff,emissive:0x1c3f80}));ball.position.set(p[0],1.55,p[1]);ball.userData={id:'TH-'+(i+1),kind:'센서',t:(23.2+Math.random()*1.4).toFixed(1),rh:(42+Math.random()*5).toFixed(0)};scene.add(ball);sensors.push(ball);});
const smokes=[];[[-4,0],[0.5,0.5],[4.5,-1]].forEach((p,i)=>{const d=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,0.04,20),new THREE.MeshStandardMaterial({color:0xe0e0e0}));d.position.set(p[0],ROOM.h-0.02,p[1]);d.userData={id:'SMK-'+(i+1),kind:'연기감지기',st:'정상'};scene.add(d);smokes.push(d);const l=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(p[0],ROOM.h,p[1]),new THREE.Vector3(p[0],ROOM.h-0.3,p[1])]),new THREE.LineBasicMaterial({color:0x525252}));scene.add(l);});
// ---------- leak zones (floor polygons under CRACs + UPS)
const leakGroup=new THREE.Group(); scene.add(leakGroup);
const zones=[{id:'ZONE-1',x:-4.6,z:-ROOM.d/2+1.1,w:2.4,d:1.4,st:'ok'},{id:'ZONE-2',x:0,z:-ROOM.d/2+1.1,w:2.4,d:1.4,st:'ok'},{id:'ZONE-3',x:4.6,z:-ROOM.d/2+1.1,w:2.4,d:1.4,st:'leak'},{id:'ZONE-4',x:ROOM.w/2-1.3,z:-2.3,w:1.6,d:2.6,st:'ok'}];
const zoneMeshes=[];
zones.forEach(zn=>{const g=new THREE.PlaneGeometry(zn.w,zn.d);g.rotateX(-Math.PI/2);const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:zn.st==='leak'?C.crit:0x4589ff,transparent:true,opacity:zn.st==='leak'?0.45:0.18,depthWrite:false}));m.position.set(zn.x,0.012,zn.z);m.userData={id:zn.id,kind:'누수 존',st:zn.st};leakGroup.add(m);zoneMeshes.push(m);const e=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-zn.w/2,0,-zn.d/2),new THREE.Vector3(zn.w/2,0,-zn.d/2),new THREE.Vector3(zn.w/2,0,zn.d/2),new THREE.Vector3(-zn.w/2,0,zn.d/2)]),new THREE.LineDashedMaterial({color:zn.st==='leak'?0xff8389:0x78a9ff,dashSize:0.15,gapSize:0.1}));e.computeLineDistances();e.position.set(zn.x,0.02,zn.z);leakGroup.add(e);const lab=label(zn.id+(zn.st==='leak'?' · 누수 감지':''),2.0,zn.st==='leak'?'#ff8389':'#78a9ff');lab.position.set(zn.x,0.35,zn.z);leakGroup.add(lab);});
// ---------- heatmap (floor vertex colors)
const hot=racks.filter(r=>!r.userData.empty).map(r=>({x:r.position.x,z:r.position.z,t:r.userData.temp}));
cracSpec.forEach(s=>hot.push({x:s.x,z:-ROOM.d/2+0.5,t:s.st==='warn'?20.5:18.3}));
function tempAt(x,z){let num=0,den=0;for(const h of hot){const d2=(x-h.x)**2+(z-h.z)**2+0.15;const w=1/(d2*d2);num+=w*h.t;den+=w;}return num/den;}
const pos=floorGeo.attributes.position; const colors=new Float32Array(pos.count*3); const col=new THREE.Color();
for(let i=0;i<pos.count;i++){const t=tempAt(pos.getX(i),pos.getZ(i));const u=Math.min(1,Math.max(0,(t-19)/9));col.setHSL(0.62-0.62*u,0.9,0.22+0.28*u);colors[i*3]=col.r;colors[i*3+1]=col.g;colors[i*3+2]=col.b;}
floorGeo.setAttribute('color',new THREE.BufferAttribute(colors,3));
// ---------- camera control (custom orbit)
const target=new THREE.Vector3(0,0.6,0.4); let sph={r:22,theta:Math.PI*0.22,phi:Math.PI*0.36};
function applyCam(){camera.position.set(target.x+sph.r*Math.sin(sph.phi)*Math.sin(sph.theta),target.y+sph.r*Math.cos(sph.phi),target.z+sph.r*Math.sin(sph.phi)*Math.cos(sph.theta));camera.lookAt(target);}
let drag=null; canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,b:e.button};canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointerup',e=>{drag=null;});
canvas.addEventListener('pointermove',e=>{if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;if(drag.b===0){sph.theta-=dx*0.006;sph.phi=Math.min(Math.PI*0.49,Math.max(0.12,sph.phi-dy*0.006));}else{const right=new THREE.Vector3().crossVectors(camera.getWorldDirection(new THREE.Vector3()),camera.up).normalize();target.addScaledVector(right,-dx*0.012*sph.r/19);target.y=Math.max(0,Math.min(3,target.y+dy*0.012*sph.r/19));}applyCam();auto=false;}else hover(e);});
canvas.addEventListener('wheel',e=>{e.preventDefault();sph.r=Math.min(45,Math.max(4,sph.r*(1+e.deltaY*0.0012)));applyCam();},{passive:false});
canvas.addEventListener('contextmenu',e=>e.preventDefault());
canvas.addEventListener('click',e=>{const o=pick(e);if(o)select(o);});
let auto=true;
function preset(n){auto=false;if(n==='iso')sph={r:19,theta:Math.PI*0.22,phi:Math.PI*0.34};if(n==='top')sph={r:17,theta:0,phi:0.13};if(n==='aisle')sph={r:6,theta:Math.PI*0.5,phi:Math.PI*0.44};if(n==='crac')sph={r:9,theta:Math.PI,phi:Math.PI*0.4};applyCam();}
// ---------- layers
let mode='status';
function colorRacks(){racks.forEach(r=>{const u=r.userData;if(u.empty){r.material.color.setHex(C.empty);return;}if(mode==='status')r.material.color.setHex(C[u.st]);else if(mode==='load'){const t=Math.min(1,u.kw/7);r.material.color.setHSL(0.55-0.55*t,0.85,0.35+0.15*t);}else{const t=Math.min(1,Math.max(0,(u.temp-22)/7));r.material.color.setHSL(0.6-0.6*t,0.9,0.35+0.15*t);}});}
// ---------- picking
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();const tip=opts.tip;
function pick(e){const r=canvas.getBoundingClientRect();mouse.x=((e.clientX-r.left)/r.width)*2-1;mouse.y=-((e.clientY-r.top)/r.height)*2+1;ray.setFromCamera(mouse,camera);const hits=ray.intersectObjects([...racks,...cracs,...upsMeshes,...sensors,...smokes,...zoneMeshes],false);return hits.length?hits[0].object:null;}
let hovered=null;
function hover(e){const o=pick(e);if(o!==hovered){if(hovered&&hovered.material.emissive)hovered.material.emissive.setHex(hovered.userData._em||0);hovered=o;if(o&&o.material.emissive){o.userData._em=o.material.emissive.getHex();o.material.emissive.setHex(0x334466);}}
 if(o){const u=o.userData;tip.style.display='block';tip.style.left=(e.clientX+14)+'px';tip.style.top=(e.clientY+14)+'px';tip.innerHTML=describe(u);}else tip.style.display='none';}
function describe(u){if(u.kind==='CRAC')return `<b>${u.id}</b> · ${u.rt}RT<br>팬 ${u.fan}% · ${u.st==='warn'?'<span class="w">팬 감속 · 필터 경보</span>':'정상'}`;if(u.kind==='UPS')return `<b>${u.id}</b> · Vertiv<br>부하 ${u.load}% · ONLINE`;if(u.kind==='센서')return `<b>${u.id}</b> 온습도<br>${u.t}°C · ${u.rh}% RH`;if(u.kind==='연기감지기')return `<b>${u.id}</b><br>${u.st}`;if(u.kind==='누수 존')return `<b>${u.id}</b><br>${u.st==='leak'?'<span class="c">누수 감지 · 11:02</span>':'정상'}`;
 if(u.empty)return `<b>${u.id}</b> · 공랙`;const s={ok:'정상',hot:'고부하',warn:'온도 주의',crit:'<span class="c">알람 · 핫스팟</span>'}[u.st];return `<b>랙 ${u.id}</b><br>${u.kw} kW · 상단 ${u.temp}°C<br>${s}`;}
function select(o){const u=o.userData;opts.onSelect&&opts.onSelect(describe(u)+(u.id==='B07'?'<div class="ai">AI: CRAC-2 팬 감속과 상관 91% · 권고: CRAC-2 필터 교체, B07 부하 2kW 이전</div>':'')+(u.kind==='누수 존'&&u.st==='leak'?'<div class="ai">LP6000 Zone-3 · CRAC-2 하부 · HAEM 시설 확인 중 · 티켓 T-1151</div>':''));}
// ---------- animate
const clock=new THREE.Clock();
function resize(){const w=canvas.clientWidth,h=canvas.clientHeight;if(canvas.width!==Math.floor(w*renderer.getPixelRatio())){renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}}
const b07=racks.find(r=>r.userData.id==='B07'),z3=zoneMeshes.find(z=>z.userData.st==='leak');
let running=true;function tick(){if(!running)return;resize();const t=clock.getElapsedTime();if(auto){sph.theta+=0.0012;applyCam();}
 const p=(Math.sin(t*4)+1)/2; if(b07&&hovered!==b07)b07.material.emissive.setHex(p>0.5?0x6a1016:0x000000); z3.material.opacity=0.25+0.35*p; cracs[1].material.emissive.setHex(p>0.7?0x4a3a05:0x000000);
 
 renderer.render(scene,camera);requestAnimationFrame(tick);}
colorRacks();applyCam();tick();
return {preset,setMode:(m)=>{mode=m;colorRacks();},setHeat:(v)=>{floorMat.vertexColors=v;floorMat.color.setHex(v?0xffffff:C.floor);floorMat.needsUpdate=true;},setLeak:(v)=>{leakGroup.visible=v;},setSensor:(v)=>{sensors.forEach(s=>s.visible=v);smokes.forEach(s=>s.visible=v);},dispose:()=>{running=false;renderer.dispose();}};

}
