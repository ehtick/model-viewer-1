import * as pc from 'playcanvas';

const gamma = 2.2;

const vshader: string = `
attribute vec2 vertex_position;
varying vec2 texcoord;
void main(void) {
    gl_Position = vec4(vertex_position, 0.5, 1.0);
    texcoord = vertex_position.xy * 0.5 + 0.5;
}
`;

const fshader: string = `
varying vec2 texcoord;
uniform sampler2D texture_multiframeSource;
uniform float multiplier;
uniform float power;
void main(void) {
    vec4 t = texture2D(texture_multiframeSource, texcoord);
    gl_FragColor = vec4(pow(t.xyz * multiplier, vec3(power)), 1.0);
}
`;

const vertexShaderHeader = (device: pc.GraphicsDevice) => {
    // @ts-ignore
    return device.webgl2 ? `#version 300 es\n\n${pc.shaderChunks.gles3VS}\n` : '';
}

const fragmentShaderHeader = (device: pc.GraphicsDevice) => {
    // @ts-ignore
    return (device.webgl2 ? `#version 300 es\n\n${pc.shaderChunks.gles3PS}\n` : '') +
            `precision ${device.precision} float;\n\n`;
}

const supportsFloat16 = (device: pc.GraphicsDevice): boolean => {
    return device.extTextureHalfFloat && device.textureHalfFloatRenderable;
};

const supportsFloat32 = (device: pc.GraphicsDevice): boolean => {
    return device.extTextureFloat && device.textureFloatRenderable;
};

// lighting source should be stored HDR
const choosePixelFormat = (device: pc.GraphicsDevice): number => {
    return supportsFloat16(device) ? pc.PIXELFORMAT_RGBA16F :
        supportsFloat32(device) ? pc.PIXELFORMAT_RGBA32F :
            pc.PIXELFORMAT_R8_G8_B8_A8;
};

class Multiframe {
    device: pc.GraphicsDevice;
    camera: pc.CameraComponent;
    shader: pc.Shader = null;
    pixelFormat: number;
    multiframeTexUniform: pc.ScopeId = null;
    multiplierUniform: pc.ScopeId = null;
    powerUniform: pc.ScopeId = null;
    globalTextureBiasUniform: pc.ScopeId = null;
    firstTexture: pc.Texture = null;
    firstRenderTarget: pc.RenderTarget = null;
    accumTexture: pc.Texture = null;
    accumRenderTarget: pc.RenderTarget = null;
    sampleId: number = 0;
    samples: pc.Vec2[] = [];

    constructor(device: pc.GraphicsDevice, camera: pc.CameraComponent, numSamples: number) {
        this.device = device;
        this.camera = camera;

        // generate jittered grid samples (poisson would be better)
        for (let x = 0; x < numSamples; ++x) {
            for (let y = 0; y < numSamples; ++y) {
                this.samples.push(new pc.Vec2(
                    (x + Math.random()) / numSamples * 2.0 - 1.0,
                    (y + Math.random()) / numSamples * 2.0 - 1.0
                ));
            }
        }

        // closes sample first
        this.samples.sort((a, b) => {
            const aL = a.length();
            const bL = b.length();
            return aL < bL ? -1 : (bL < aL ? 1 : 0);
        });

        const pmat = this.camera.projectionMatrix;
        let store = new pc.Vec2();

        this.camera.onPreRender = () => {
            const sample = this.samples[this.sampleId];

            store.set(pmat.data[12], pmat.data[13]);
            pmat.data[8] += sample.x / device.width;
            pmat.data[9] += sample.y / device.height;

            // look away
            this.camera._camera._viewMatDirty = true;
            this.camera._camera._viewProjMatDirty = true;

            this.globalTextureBiasUniform.setValue(this.sampleId === 0 ? 0.0 : -5.0);
            // this.globalTextureBiasUniform.setValue(-5.0);
        }

        this.camera.onPostRender = () => {
            pmat.data[8] = store.x;
            pmat.data[9] = store.y;
        }

        this.shader = new pc.Shader(device, {
            attributes: {
                vertex_position: pc.SEMANTIC_POSITION
            },
            vshader: vertexShaderHeader(device) + vshader,
            fshader: fragmentShaderHeader(device) + fshader
        });

        this.pixelFormat = choosePixelFormat(device);
        this.multiframeTexUniform = device.scope.resolve('texture_multiframeSource');
        this.multiplierUniform = device.scope.resolve('multiplier');
        this.powerUniform = device.scope.resolve('power');
        this.globalTextureBiasUniform = device.scope.resolve('globalTextureBias');

        const handler = () => {
            this.destroy();
        };

        device.once('destroy', handler);
        device.on('devicelost', handler);
    }

    destroy() {
        if (this.firstTexture) {
            this.firstTexture.destroy();
            this.firstTexture = null;
        }

        if (this.firstRenderTarget) {
            this.firstRenderTarget.destroy();
            this.firstRenderTarget = null;
        }

        if (this.accumRenderTarget) {
            this.accumRenderTarget.destroy();
            this.accumRenderTarget = null;
        }

        if (this.accumTexture) {
            this.accumTexture.destroy();
            this.accumTexture = null;
        }
    }

    moved() {
        this.sampleId = 0;
    }

    create() {
        this.firstTexture = new pc.Texture(this.device, {
            width: this.device.width,
            height: this.device.height,
            mipmaps: false
        });
        this.firstRenderTarget = new pc.RenderTarget({
            colorBuffer: this.firstTexture,
            depth: false
        });

        this.accumTexture = new pc.Texture(this.device, {
            width: this.device.width,
            height: this.device.height,
            format: this.pixelFormat,
            mipmaps: false
        });

        this.accumRenderTarget = new pc.RenderTarget({
            colorBuffer: this.accumTexture,
            depth: false
        });
    }

    prepareTexture() {
        const device = this.device;

        if (this.accumTexture && (this.accumTexture.width !== device.width || this.accumTexture.height !== device.height)) {
            this.destroy();
        }

        if (!this.accumTexture) {
            this.create();
        }

        const sampleCnt = this.samples.length;

        if (this.camera.renderTarget && this.sampleId < sampleCnt) {
            const sourceTex = this.camera.renderTarget.colorBuffer;
            // const sourceTex = this.camera.renderTarget.depthBuffer;

            if (this.sampleId === 0) {
                // store the grabpass in both accumulation and current
                this.multiframeTexUniform.setValue(sourceTex);
                this.multiplierUniform.setValue(1.0);
                this.powerUniform.setValue(gamma);
                pc.drawQuadWithShader(device, this.accumRenderTarget, this.shader, null, null, true);

                this.powerUniform.setValue(1.0);
                pc.drawQuadWithShader(device, this.firstRenderTarget, this.shader, null, null, true);
            } else {
                // blend grabpass with accumulation buffer
                const blendSrc = device.blendSrc;
                const blendDst = device.blendDst;
                const blendSrcAlpha = device.blendSrcAlpha;
                const blendDstAlpha = device.blendDstAlpha;

                const gl = device.gl;
                gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA, gl.ONE, gl.ZERO);
                gl.blendColor(0, 0, 0, 1.0 / (this.sampleId + 1));

                this.multiframeTexUniform.setValue(sourceTex);
                this.multiplierUniform.setValue(1.0);
                this.powerUniform.setValue(gamma);
                pc.drawQuadWithShader(device, this.accumRenderTarget, this.shader, null, null, true);

                // restore states
                device.setBlendFunctionSeparate(blendSrc, blendDst, blendSrcAlpha, blendDstAlpha);

                // resolve final frame
                if (this.sampleId === (sampleCnt - 1)) {
                    this.multiframeTexUniform.setValue(this.accumTexture);
                    this.multiplierUniform.setValue(1.0);
                    this.powerUniform.setValue(1.0 / gamma);
                    pc.drawQuadWithShader(device, this.firstRenderTarget, this.shader);
                }
            }
        }

        // replace backbuffer with multiframe buffer
        this.multiframeTexUniform.setValue(this.firstTexture);
        this.multiplierUniform.setValue(1.0);
        this.powerUniform.setValue(1.0);
        pc.drawQuadWithShader(device, null, this.shader);

        if (this.sampleId < sampleCnt) {
            this.sampleId++;
        }

        return this.sampleId < sampleCnt;
    }
}

export {
    Multiframe
}