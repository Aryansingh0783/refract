/*
  Refract.fx  -  look presets for DLSS 5 games (ReShade 5+/6)

  Three looks, switchable in game without reopening ReShade:
    F13  Default           (pass-through, grade skipped)
    F14  Cinematic
    F15  Natural Lighting
  Refract's overlay and hotkeys send F13-F15 for you; almost no keyboard has
  those keys, so they never collide with game bindings.

  Cost: one full-screen ALU-only pass plus two 1x1 state passes. No extra
  full-resolution textures, no neighbourhood sampling. When Default is active
  and the transition has finished, the grade pass returns the input untouched.

  The look is kept in a 1x1 state texture that ping-pongs every frame, so the
  selection survives until the effect is reloaded; then RefractStartLook
  (written by Refract into the preset) is used again.

  Self-contained: does not need ReShade.fxh.
*/

#ifndef BUFFER_COLOR_SPACE
  #define BUFFER_COLOR_SPACE 1
#endif

// ---------------------------------------------------------------- controls
uniform int RefractStartLook <
  ui_type = "combo"; ui_items = "Default\0Cinematic\0Natural Lighting\0";
  ui_label = "Startup look";
  ui_tooltip = "Look used when the effect loads. Switch live with F13 / F14 / F15.";
> = 0;

uniform float RefractTransition <
  ui_type = "slider"; ui_min = 0.0; ui_max = 2.0; ui_step = 0.05;
  ui_label = "Transition (seconds)";
> = 0.6;

uniform float Cine_Contrast   < ui_type = "slider"; ui_category = "Cinematic"; ui_label = "Contrast curve"; ui_min = 0.0; ui_max = 0.6; > = 0.22;
uniform float Cine_Saturation < ui_type = "slider"; ui_category = "Cinematic"; ui_label = "Saturation";     ui_min = 0.7; ui_max = 1.3; > = 1.06;
uniform float Cine_SplitTone  < ui_type = "slider"; ui_category = "Cinematic"; ui_label = "Split toning";   ui_min = 0.0; ui_max = 1.0; > = 0.35;
uniform float Cine_Vignette   < ui_type = "slider"; ui_category = "Cinematic"; ui_label = "Vignette";       ui_min = 0.0; ui_max = 0.6; > = 0.28;
uniform float Cine_Grain      < ui_type = "slider"; ui_category = "Cinematic"; ui_label = "Film grain";     ui_min = 0.0; ui_max = 0.1; > = 0.03;

uniform float Nat_Rolloff     < ui_type = "slider"; ui_category = "Natural Lighting"; ui_label = "Highlight rolloff"; ui_min = 0.0;  ui_max = 1.0;  > = 0.4;
uniform float Nat_ShadowLift  < ui_type = "slider"; ui_category = "Natural Lighting"; ui_label = "Shadow lift";       ui_min = 0.0;  ui_max = 0.12; > = 0.035;
uniform float Nat_Saturation  < ui_type = "slider"; ui_category = "Natural Lighting"; ui_label = "Saturation";        ui_min = 0.6;  ui_max = 1.1;  > = 0.9;
uniform float Nat_Contrast    < ui_type = "slider"; ui_category = "Natural Lighting"; ui_label = "Contrast";          ui_min = -0.3; ui_max = 0.2;  > = -0.08;
uniform float Nat_Warmth      < ui_type = "slider"; ui_category = "Natural Lighting"; ui_label = "Warmth";            ui_min = -1.0; ui_max = 1.0;  > = 0.0;

// ---------------------------------------------------------------- runtime sources
uniform bool  KeyDefault   < source = "key"; keycode = 0x7C; mode = "press"; >;
uniform bool  KeyCinematic < source = "key"; keycode = 0x7D; mode = "press"; >;
uniform bool  KeyNatural   < source = "key"; keycode = 0x7E; mode = "press"; >;
uniform float FrameTime    < source = "frametime"; >;
uniform int   FrameCount   < source = "framecount"; >;

// ---------------------------------------------------------------- resources
texture2D RefractBackBufferTex : COLOR;
sampler2D RefractBackBuffer { Texture = RefractBackBufferTex; };

// x = selected look (0,1,2)  y = cinematic weight  z = natural weight  w = initialised flag
texture2D RefractStateA { Width = 1; Height = 1; Format = RGBA16F; };
texture2D RefractStateB { Width = 1; Height = 1; Format = RGBA16F; };
sampler2D RefractSampA { Texture = RefractStateA; MinFilter = POINT; MagFilter = POINT; MipFilter = POINT; };
sampler2D RefractSampB { Texture = RefractStateB; MinFilter = POINT; MagFilter = POINT; MipFilter = POINT; };

// ---------------------------------------------------------------- helpers
void RefractVS(in uint id : SV_VertexID, out float4 pos : SV_Position, out float2 uv : TEXCOORD)
{
  uv.x = (id == 2) ? 2.0 : 0.0;
  uv.y = (id == 1) ? 2.0 : 0.0;
  pos = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

static const float3 LUMA = float3(0.2126, 0.7152, 0.0722);

float3 SCurve(float3 x) { return x * x * (3.0 - 2.0 * x); }

float Hash(float2 p)
{
  float3 p3 = frac(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return frac((p3.x + p3.y) * p3.z);
}

float3 Cinematic(float3 c, float2 uv)
{
  float l = dot(c, LUMA);
  c = saturate(l + (c - l) * Cine_Saturation);
  c += Cine_Contrast * (SCurve(c) - c);

  l = dot(c, LUMA);
  float sh = (1.0 - l) * (1.0 - l);
  float hi = l * l;
  c += Cine_SplitTone * (float3(-0.04, 0.02, 0.05) * sh + float3(0.05, 0.015, -0.04) * hi);

  float aspect = BUFFER_WIDTH * BUFFER_RCP_HEIGHT;
  float2 d2 = (uv - 0.5) * float2(aspect, 1.0);
  float d = length(d2) / length(float2(0.5 * aspect, 0.5));
  c *= 1.0 - Cine_Vignette * smoothstep(0.45, 1.0, d);

  // Mid-tone weighted grain, re-seeded per frame.
  float n = Hash(uv * float2(BUFFER_WIDTH, BUFFER_HEIGHT) + float(uint(FrameCount) % 1024u) * 17.0) - 0.5;
  c += n * Cine_Grain * (1.0 - abs(l * 2.0 - 1.0));
  return saturate(c);
}

float3 Natural(float3 c)
{
  float3 inv = 1.0 - c;
  c += Nat_ShadowLift * inv * inv * inv;

  float l = dot(c, LUMA);
  float l2 = l - Nat_Rolloff * 0.15 * l * l * l * l;
  c *= (l > 1e-4) ? (l2 / l) : 1.0;

  float l3 = dot(c, LUMA);
  c = saturate(l3 + (c - l3) * Nat_Saturation);
  c += Nat_Contrast * (SCurve(c) - c);

  float w = Nat_Warmth * 0.06;
  c *= float3(1.0 + w, 1.0, 1.0 - w);
  return saturate(c);
}

// ---------------------------------------------------------------- passes
float4 PS_Update(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
  float4 s = tex2D(RefractSampB, float2(0.5, 0.5));
  bool init = s.w < 0.5;

  float look = init ? float(RefractStartLook) : s.x;
  if (KeyDefault)   look = 0.0;
  if (KeyCinematic) look = 1.0;
  if (KeyNatural)   look = 2.0;

  float2 target = float2(abs(look - 1.0) < 0.5 ? 1.0 : 0.0, abs(look - 2.0) < 0.5 ? 1.0 : 0.0);
  float2 w = init ? target : s.yz;
  float stepSize = (RefractTransition <= 0.001) ? 1.0 : saturate(FrameTime * 0.001 / RefractTransition);
  w += clamp(target - w, -stepSize, stepSize);

  return float4(look, w, 1.0);
}

float4 PS_Store(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
  return tex2D(RefractSampA, float2(0.5, 0.5));
}

float4 PS_Grade(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
  float4 src = tex2D(RefractBackBuffer, uv);
#if BUFFER_COLOR_SPACE > 1
  // HDR swap chain (scRGB / HDR10): these curves assume SDR 0-1, so stay out of the way.
  return src;
#else
  float4 s = tex2D(RefractSampA, float2(0.5, 0.5));
  float wc = s.y;
  float wn = s.z;
  if (wc + wn < 0.001) return src;

  float3 c = src.rgb;
  float3 outc = c;
  if (wc > 0.001) outc += wc * (Cinematic(c, uv) - c);
  if (wn > 0.001) outc += wn * (Natural(c) - c);
  return float4(saturate(outc), src.a);
#endif
}

technique Refract <
  ui_label = "Refract Looks";
  ui_tooltip = "Default / Cinematic / Natural Lighting. Live switch: F13 / F14 / F15 (sent by Refract).";
>
{
  pass Update { VertexShader = RefractVS; PixelShader = PS_Update; RenderTarget = RefractStateA; }
  pass Store  { VertexShader = RefractVS; PixelShader = PS_Store;  RenderTarget = RefractStateB; }
  pass Grade  { VertexShader = RefractVS; PixelShader = PS_Grade; }
}
