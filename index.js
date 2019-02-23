const fs = require('fs');
const { EventEmitter } = require('events');
const { promisify } = require('util');
const HttpError = require('http-errors')
const path = require('path');
const fsReadDir = promisify(fs.readdir);
const fsReadFile = promisify(fs.readFile);

const DEFAULT_OPTIONS = {
    frameRate: 10,
    boundary: "mjpeg-frame-boundary",
    timeLimit: 0,
    loop: true,
    direction: 'forward'
};

async function getFiles(path, direction = 'forward') {
    let order = direction === 'forward' ? -1 : 1
    let files = await fsReadDir(path);
    return files.sort((f1, f2) => ((f1 < f2) ? order : ((f1 > f1) ? -order : 0)));
}

class MJPEG extends EventEmitter {
    constructor(directory, opts) {
        super();
        this.opts = { ...DEFAULT_OPTIONS, ...opts };
        this.directory = directory;
        this.delayMs = 1000 / this.opts.frameRate;
        this.headers = {
            'Content-Type': `multipart/x-mixed-replace; boundary=${this.opts.boundary}`,
            'Cache-Control': 'no-cache',
            'Connection': 'close',
            'Pragma': 'no-cache'
        }
        this.newFrame = this.newFrame.bind(this);
        this.end = this.end.bind(this);
    }

    getInfo() {
        return {
            opts: this.opts,
            dir: this.directory,
            framesAvailable: this.framesAvailable,
            frameCount: this.frameCount,
            contentBytes: this.contentBytes,
            streamStart: this.streamStart,
            streamEnd: this.streamEnd,
            ms: (this.streamEnd - this.streamStart),
            fps: this.frameCount / ((this.streamEnd - this.streamStart) / 1000)
        }
    }
    end(err) {
        if (this.isRunning) {
            if (err) {
                this.res.status(err.status);
                this.emit('error', err);
            };
            this.isRunning = false;
            clearTimeout(this.frameTimer);
            this.res.end();
            this.streamEnd = new Date();
            this.emit('end', this.getInfo());
        }
    }

    async stream(res) {
        this.res = res;
        this.isRunning = true;
        this.frameIndex = 0;
        this.frameCount = 0;
        this.contentBytes = 0;
        this.files = [];
        this.res.connection.on('close', this.end);
        if (this.opts.timeLimit) setTimeout(this.end, this.opts.timeLimit);
        try {
            this.files = await getFiles(this.directory, this.opts.direction);
            if (this.files.length) {
                this.framesAvailable = this.files.length;
                this.emit('start', this.getInfo())
                this.streamStart = new Date();
                this.res.writeHead(200, this.headers);
                this.newFrame();
            } else this.end(HttpError(404, `no frame images found in ${this.directory}`));
        }
        catch (err) {
            this.end(HttpError(404, err.message));
        }
    }

    async newFrame() {
        if (this.isRunning) {
            try {
                let content = await fsReadFile(path.resolve(this.directory, this.files[this.frameIndex]));
                this.send(content);
                this.frameCount++;
                // emit frame stats
                this.emit('frame', {
                    filename: this.files[this.frameIndex],
                    frameIndex: this.frameIndex,
                    frameCount: this.frameCount,
                    size: content.length
                });
                this.frameIndex = this.frameCount % this.files.length;
                this.contentBytes += content.length;
                if (this.frameIndex === 0 && !this.opts.loop) this.end();
                else this.frameTimer = setTimeout(this.newFrame, this.delayMs);
            }
            catch (err) {
                this.emit('error', err);
            }
        }
    }

    send(content) {
        this.res.write(`--${this.opts.boundary}\r\n`);
        this.res.write('Content-Type: image/jpeg\r\n');
        this.res.write(`Content-Length: ${content.length}\r\n`);
        this.res.write('\r\n');
        this.res.write(content, 'binary');
        this.res.write('\r\n');
    }
}

module.exports = MJPEG;