export namespace device {
	
	export class Channel {
	    path: string;
	    device: string;
	    vid: string;
	    pid: string;
	    usagePage: number;
	    usage: number;
	    usageText: string;
	    inLen: number;
	    outLen: number;
	    featureLen: number;
	    role: string;
	    roleLabel: string;
	    via: boolean;
	    note?: string;
	
	    static createFrom(source: any = {}) {
	        return new Channel(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.device = source["device"];
	        this.vid = source["vid"];
	        this.pid = source["pid"];
	        this.usagePage = source["usagePage"];
	        this.usage = source["usage"];
	        this.usageText = source["usageText"];
	        this.inLen = source["inLen"];
	        this.outLen = source["outLen"];
	        this.featureLen = source["featureLen"];
	        this.role = source["role"];
	        this.roleLabel = source["roleLabel"];
	        this.via = source["via"];
	        this.note = source["note"];
	    }
	}
	export class Check {
	    name: string;
	    ok: boolean;
	    detail: string;
	    hint?: string;
	
	    static createFrom(source: any = {}) {
	        return new Check(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.ok = source["ok"];
	        this.detail = source["detail"];
	        this.hint = source["hint"];
	    }
	}
	export class Status {
	    connected: boolean;
	    path: string;
	    product: string;
	    manufacturer: string;
	    vid: string;
	    pid: string;
	    firmwareVersion: number;
	    kind: string;
	    kindLabel: string;
	    enumerator: string;
	    protocolVersion: number;
	    layerCount: number;
	    macroCount: number;
	    encoderConfigurable: boolean;
	    payloadLen: number;
	    layout: string;
	    donglePresent: boolean;
	    dongleName: string;
	    screenFound: boolean;
	    screenUsage: string;
	    battery: string;
	    channels: Channel[];
	    attempts: string[];
	    warnings: string[];
	    lastError: string;
	    userDisconnected: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connected = source["connected"];
	        this.path = source["path"];
	        this.product = source["product"];
	        this.manufacturer = source["manufacturer"];
	        this.vid = source["vid"];
	        this.pid = source["pid"];
	        this.firmwareVersion = source["firmwareVersion"];
	        this.kind = source["kind"];
	        this.kindLabel = source["kindLabel"];
	        this.enumerator = source["enumerator"];
	        this.protocolVersion = source["protocolVersion"];
	        this.layerCount = source["layerCount"];
	        this.macroCount = source["macroCount"];
	        this.encoderConfigurable = source["encoderConfigurable"];
	        this.payloadLen = source["payloadLen"];
	        this.layout = source["layout"];
	        this.donglePresent = source["donglePresent"];
	        this.dongleName = source["dongleName"];
	        this.screenFound = source["screenFound"];
	        this.screenUsage = source["screenUsage"];
	        this.battery = source["battery"];
	        this.channels = this.convertValues(source["channels"], Channel);
	        this.attempts = source["attempts"];
	        this.warnings = source["warnings"];
	        this.lastError = source["lastError"];
	        this.userDisconnected = source["userDisconnected"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DiagResult {
	    devices: hidwin.Info[];
	    matched: Channel[];
	    status: Status;
	    reportText: string;
	
	    static createFrom(source: any = {}) {
	        return new DiagResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.devices = this.convertValues(source["devices"], hidwin.Info);
	        this.matched = this.convertValues(source["matched"], Channel);
	        this.status = this.convertValues(source["status"], Status);
	        this.reportText = source["reportText"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MacroSlot {
	    index: number;
	    text: string;
	    bytes: number;
	
	    static createFrom(source: any = {}) {
	        return new MacroSlot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.text = source["text"];
	        this.bytes = source["bytes"];
	    }
	}
	export class MacroInfo {
	    count: number;
	    bufferSize: number;
	    stride: number;
	    usedBytes: number;
	    slots: MacroSlot[];
	
	    static createFrom(source: any = {}) {
	        return new MacroInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.count = source["count"];
	        this.bufferSize = source["bufferSize"];
	        this.stride = source["stride"];
	        this.usedBytes = source["usedBytes"];
	        this.slots = this.convertValues(source["slots"], MacroSlot);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class SelfCheck {
	    checks: Check[];
	    reportText: string;
	    okCount: number;
	    failCount: number;
	
	    static createFrom(source: any = {}) {
	        return new SelfCheck(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.checks = this.convertValues(source["checks"], Check);
	        this.reportText = source["reportText"];
	        this.okCount = source["okCount"];
	        this.failCount = source["failCount"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace hidwin {
	
	export class Info {
	    path: string;
	    vendorId: number;
	    productId: number;
	    versionNumber: number;
	    usagePage: number;
	    usage: number;
	    inReportLength: number;
	    outReportLength: number;
	    featureReportLength: number;
	    product: string;
	    manufacturer: string;
	    serial: string;
	    enumerator: string;
	    deviceDesc: string;
	    openError?: string;
	
	    static createFrom(source: any = {}) {
	        return new Info(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.vendorId = source["vendorId"];
	        this.productId = source["productId"];
	        this.versionNumber = source["versionNumber"];
	        this.usagePage = source["usagePage"];
	        this.usage = source["usage"];
	        this.inReportLength = source["inReportLength"];
	        this.outReportLength = source["outReportLength"];
	        this.featureReportLength = source["featureReportLength"];
	        this.product = source["product"];
	        this.manufacturer = source["manufacturer"];
	        this.serial = source["serial"];
	        this.enumerator = source["enumerator"];
	        this.deviceDesc = source["deviceDesc"];
	        this.openError = source["openError"];
	    }
	}

}

export namespace main {
	
	export class GifPreview {
	    images: string[];
	    total: number;
	
	    static createFrom(source: any = {}) {
	        return new GifPreview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.images = source["images"];
	        this.total = source["total"];
	    }
	}
	export class KeyChange {
	    layer: number;
	    row: number;
	    col: number;
	    keycode: number;
	
	    static createFrom(source: any = {}) {
	        return new KeyChange(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.layer = source["layer"];
	        this.row = source["row"];
	        this.col = source["col"];
	        this.keycode = source["keycode"];
	    }
	}

}

export namespace screen {
	
	export class AniResult {
	    declareStatus: number;
	    frames: number;
	    delayMs: number;
	    bytes: number;
	    elapsedMs: number;
	    skipped: number;
	
	    static createFrom(source: any = {}) {
	        return new AniResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.declareStatus = source["declareStatus"];
	        this.frames = source["frames"];
	        this.delayMs = source["delayMs"];
	        this.bytes = source["bytes"];
	        this.elapsedMs = source["elapsedMs"];
	        this.skipped = source["skipped"];
	    }
	}
	export class Params {
	    width: number;
	    height: number;
	    fitMode: string;
	    byteOrder: string;
	    usagePage: number;
	    usage: number;
	    reportSize: number;
	    headerTemplate: string;
	    beginTemplate: string;
	    endTemplate: string;
	    chunkDelayMs: number;
	    slot: number;
	    ackWaitMs: number;
	    gapMs: number;
	    maxBytes: number;
	
	    static createFrom(source: any = {}) {
	        return new Params(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.width = source["width"];
	        this.height = source["height"];
	        this.fitMode = source["fitMode"];
	        this.byteOrder = source["byteOrder"];
	        this.usagePage = source["usagePage"];
	        this.usage = source["usage"];
	        this.reportSize = source["reportSize"];
	        this.headerTemplate = source["headerTemplate"];
	        this.beginTemplate = source["beginTemplate"];
	        this.endTemplate = source["endTemplate"];
	        this.chunkDelayMs = source["chunkDelayMs"];
	        this.slot = source["slot"];
	        this.ackWaitMs = source["ackWaitMs"];
	        this.gapMs = source["gapMs"];
	        this.maxBytes = source["maxBytes"];
	    }
	}
	export class Preview {
	    dataUrl: string;
	    width: number;
	    height: number;
	    sourceWidth: number;
	    sourceHeight: number;
	    frames: number;
	    pixelBytes: number;
	    chunkCount: number;
	    payloadPerChunk: number;
	    hexPreview: string[];
	    warnings: string[];
	
	    static createFrom(source: any = {}) {
	        return new Preview(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dataUrl = source["dataUrl"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.sourceWidth = source["sourceWidth"];
	        this.sourceHeight = source["sourceHeight"];
	        this.frames = source["frames"];
	        this.pixelBytes = source["pixelBytes"];
	        this.chunkCount = source["chunkCount"];
	        this.payloadPerChunk = source["payloadPerChunk"];
	        this.hexPreview = source["hexPreview"];
	        this.warnings = source["warnings"];
	    }
	}
	export class SendResult {
	    chunks: number;
	    bytes: number;
	    elapsedMs: number;
	    warnings: string[];
	    hexLog: string[];
	
	    static createFrom(source: any = {}) {
	        return new SendResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.chunks = source["chunks"];
	        this.bytes = source["bytes"];
	        this.elapsedMs = source["elapsedMs"];
	        this.warnings = source["warnings"];
	        this.hexLog = source["hexLog"];
	    }
	}

}

