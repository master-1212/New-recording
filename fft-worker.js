// Chunked overview analysis: bounded output keeps hour-long recordings iPad-safe.
self.onmessage = ({ data }) => {
  const { samples, sampleRate, columns = 1200, bins = 48 } = data;
  const length = samples.length, stride = Math.max(1, Math.floor(length / columns));
  const waveform = new Float32Array(columns), rms = new Float32Array(columns), activity = new Float32Array(columns);
  const spectrum = new Uint8Array(columns * bins);
  for (let x = 0; x < columns; x++) {
    const start = x * stride, end = Math.min(length, start + stride); let peak = 0, sum = 0, zc = 0, prev = samples[start] || 0;
    const step = Math.max(1, Math.floor((end - start) / 512));
    for (let i = start; i < end; i += step) { const v=samples[i]; peak=Math.max(peak,Math.abs(v)); sum+=v*v; if ((v>=0)!=(prev>=0)) zc++; prev=v; }
    const n=Math.max(1,Math.ceil((end-start)/step)); waveform[x]=peak; rms[x]=Math.sqrt(sum/n);
    const crossing=zc/n, energy=Math.min(1,rms[x]*8); activity[x]=Math.max(0,Math.min(1,energy*(1-Math.abs(crossing-.12)*3)));
    // A compact multi-band Goertzel-style estimate is sufficient for the navigation heatmap.
    for(let b=0;b<bins;b++){const freq=70*Math.pow((Math.min(12000,sampleRate/2)/70),b/(bins-1));const omega=2*Math.PI*freq/sampleRate*step;let re=0,im=0,k=0;for(let i=start;i<end&&k<128;i+=Math.max(step,Math.floor((end-start)/128)),k++){const v=samples[i];re+=v*Math.cos(omega*k);im-=v*Math.sin(omega*k)}spectrum[x*bins+b]=Math.min(255,Math.sqrt(re*re+im*im)*4)}
  }
  self.postMessage({ waveform,rms,activity,spectrum,bins },[waveform.buffer,rms.buffer,activity.buffer,spectrum.buffer]);
};
