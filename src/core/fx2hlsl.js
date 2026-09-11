'use strict';
// Verification helper: lowers Refract.fx (ReShade FX) to plain HLSL SM5 so the math can be
// compiled by Windows' own d3dcompiler_47.dll. ReShade-only syntax (annotations, texture and
// sampler blocks, techniques) is rewritten; everything else is passed through unchanged.

function lower(fx, { width = 1920, height = 1080 } = {}) {
  let src = fx;
  const samplers = {};

  // sampler2D Name { Texture = Tex; ... };
  src = src.replace(/sampler2D\s+(\w+)\s*\{([^}]*)\}\s*;/g, (_m, name, body) => {
    const t = /Texture\s*=\s*(\w+)/.exec(body);
    samplers[name] = t ? t[1] : null;
    return `SamplerState ${name}__s;`;
  });
  // texture2D Name : COLOR;   and   texture2D Name { ... };
  src = src.replace(/texture2D\s+(\w+)\s*:\s*\w+\s*;/g, 'Texture2D $1;');
  src = src.replace(/texture2D\s+(\w+)\s*\{[^}]*\}\s*;/g, 'Texture2D $1;');
  // uniform type name < annotations > = default;
  src = src.replace(/uniform\s+(\w+)\s+(\w+)\s*<[\s\S]*?>\s*(?:=\s*[^;]+)?;/g, '$1 $2;');
  // tex2D(sampler, uv) -> Texture.Sample(sampler__s, uv)
  src = src.replace(/tex2D\(\s*(\w+)\s*,/g, (_m, s) => {
    if (!(s in samplers)) throw new Error('tex2D on unknown sampler ' + s);
    return `${samplers[s]}.Sample(${s}__s,`;
  });
  // drop technique blocks
  src = src.replace(/technique\s+\w+\s*(<[\s\S]*?>)?\s*\{[\s\S]*?\n\}/g, '');

  const header = [
    `#define BUFFER_WIDTH ${width}`,
    `#define BUFFER_HEIGHT ${height}`,
    `#define BUFFER_RCP_WIDTH (1.0 / ${width}.0)`,
    `#define BUFFER_RCP_HEIGHT (1.0 / ${height}.0)`,
    '#define BUFFER_COLOR_SPACE 1',
    '',
  ].join('\n');
  return header + src;
}

// Entry points ReShade will compile for the technique, with the profile we check them against.
const ENTRIES = [
  { entry: 'RefractVS', profile: 'vs_5_0' },
  { entry: 'PS_Update', profile: 'ps_5_0' },
  { entry: 'PS_Store', profile: 'ps_5_0' },
  { entry: 'PS_Grade', profile: 'ps_5_0' },
];

module.exports = { lower, ENTRIES };
