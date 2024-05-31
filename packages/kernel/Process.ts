import { Emulator } from "./Emulator";
import { EBADFD, ENOENT, ENOTDIR, EISDIR, EIO, ENOTEMPTY, ELIBBAD, EINVAL, EACCES } from "./Error";
import { IFile, Directory, isSymbolicLink, isDirectory, RegularFile, SymbolicLink, isRegularFile, isExecutableFile, isDeviceFile, File } from "./File";
import { Filesystem, FilesystemSession } from "./Filesystem";
import { OpenFlag, StatMode, StdReadFlag, UnlinkFlag } from "./Flags";
import { dirname, basename, join, generateFakeElfFile, concatArrayBuffer, PATH_SEPARATOR, resolve } from "./Utils";

/** ファイルの状態を示すインタフェース */
export interface Stat {
    /** ファイルのアクセス保護 */
    mode: number;
    /** ファイルの所有者 */
    owner: number;
    /** ファイルの所有グループ */
    group: number;
    /** ファイルサイズ */
    size: number;
}

/** エミュレーター情報インタフェース */
export interface EmulatorInfo {
    /** マシン名 */
    nodename: string;

    /** OS名 */
    os_name: string;

    /** OS バージョン */
    os_version: string;
}

export type FileDescriptorData = {
    /** ファイルへのパス */
    pathname: string;

    /** ディスクリプタのフラグ */
    flags: OpenFlag;

    /** 読み込み / 書き込みを行うオフセット */
    offset: number;
};

/** プロセス定義インタフェース */
export interface ProcessInit {
    /** プロセス ID */
    id: number;

    /** プロセス名 */
    name: string;

    /** ファイルディスクリプタ */
    fd?: FileDescriptorData[];

    /** ファイルシステム */
    filesystem: FilesystemSession;

    /** プロセスに与えられた引数 */
    args?: string[];

    /** プロセスの環境変数 */
    env: Partial<{
        PWD: string;
        PATH: string;
        HOME: string;
        [key: string]: string;
    }>;

    /** ユーザー ID */
    uid: number;

    /** グループ ID */
    gid: number;
}

/** プロセス */
export class Process {

    private emulator: Emulator;

    /** プロセス ID */
    public id: number;

    /** プロセス名 */
    public name: string;

    /** ファイルディスクリプタ */
    public fd: FileDescriptorData[];

    /** ファイルシステム */
    public filesystem: FilesystemSession;

    /** 引数 */
    public args: string[];

    /** 環境変数 */
    public env: ProcessInit["env"];

    /** 子プロセス */
    public children: Process[];

    /** プロセスが実行されているユーザー ID */
    public uid: number;
    /** プロセスが実行されているグループ ID */
    public gid: number;

    public constructor(emulator: Emulator, process: ProcessInit) {
        this.emulator = emulator;
        this.id = process.id;
        this.name = process.name;
        this.fd = process.fd ?? [];
        this.children = [];
        this.filesystem = process.filesystem.getSession(this);
        this.args = process.args ?? [];
        this.env = process.env;
        this.uid = 0;
        this.gid = 0;
    }

    /**
     * ファイルディスクリプタデータを取得します。
     * @param fd ファイルディスクリプタ ID
     */
    private _requireFileDescriptorData(fd: number): Process["fd"][number] {
        console.log(fd)
        console.log(this.fd)
        const fdData = this.fd[fd];
        if (!fdData) throw new EBADFD();
        return fdData;
    }
    /**
     * ファイルディスクリプタを作成します。
     * @param pathname パス名
     * @param flags アクセスモード
     */
    private _createFileDescriptor(pathname: string, flags: OpenFlag): number {
        console.log(pathname)
        const fdData = {
            pathname,
            offset: 0,
            flags
        };
        const fdId = Math.max(...Object.keys(this.fd).map(i => parseInt(i))) + 1;
        console.log(fdId)
        this.fd[fdId] = fdData;
        console.log(this.fd)
        return fdId;
    }
    /**
     * 指定されたエントリにおいて、指定されたモードの権限が有効になっているか確認します。
     * @param entry エントリ
     * @param mode モード（0 - 7 で指定）
     */
    private _isPermitted(entry: IFile, mode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7): boolean {
        let owner_mode = entry.mode >> 6;
        let group_mode = (entry.mode | 0o700) - 0o700 >> 3;
        let other_mode = (entry.mode | 0o770) - 0o770;

        let current_mode =
            (entry.owner === this.uid ? owner_mode : 0) |
            (entry.group === this.gid ? group_mode : 0) |
            other_mode;

        return !!(current_mode & mode);
    }

    /**
     * ファイルディスクリプタを開きます。
     * @param pathname パス名
     * @param flags アクセスモード
     */
    public open(pathname: string, flags: OpenFlag = 0 as OpenFlag): number {
        let entry;
        try {
            entry = this.filesystem.get(resolve(pathname, this.env.PWD));
        } catch (e) {
            if (flags & OpenFlag.WRITE && e instanceof ENOENT) {
                const parentEntry = this.filesystem.get(resolve(dirname(pathname), this.env.PWD));
                if (!this._isPermitted(parentEntry, 0o2)) throw new EACCES();

                this.filesystem.create(dirname(pathname), <RegularFile>{
                    name: basename(pathname),
                    type: "regular-file",
                    // TODO: permission
                    owner: 0,
                    group: 0,
                    mode: 0o777,
                    deleted: false,
                    data: new ArrayBuffer(0)
                });

                entry = this.filesystem.get(resolve(pathname, this.env.PWD), true);
            } else {
                throw e;
            }
        }

        // TODO: EACCES (flock)
        if (isDirectory(entry)) {
            throw new EISDIR(pathname);
        }

        if (flags & OpenFlag.READ && !this._isPermitted(entry, 0o4)) throw new EACCES();
        if (flags & OpenFlag.WRITE && !this._isPermitted(entry, 0o2)) throw new EACCES();

        const fd = this._createFileDescriptor(pathname, flags);
        this.filesystem.create(join(this.emulator.PROCESS_DIRECTORY, this.id.toString(), "fd"), <SymbolicLink>{
            name: fd.toString(),
            type: "symlink",
            owner: 0,
            group: 0,
            mode: 0o700,
            deleted: false,
            target: pathname
        });
        return fd;
    }

    /**
     * ファイルディスクリプタを閉じます。
     * @param fd ファイルディスクリプタ
     */
    public close(fd: number): void {
        this.unlink(join(this.emulator.PROCESS_DIRECTORY, this.id.toString(), "fd", fd.toString()));
        delete this.fd[fd];

        // TODO: stdio はどうする？
    }

    /**
     * ファイルの読み込みオフセット位置を変更します。
     * @param fd ファイルディスクリプタ
     * @param offset オフセット位置
     */
    public seek(fd: number, offset: number): void {
        const fdd = this._requireFileDescriptorData(fd);
        // TODO: offset < 0 || offset > file.length
        fdd.offset = offset;
    }

    /**
     * ファイルディスクリプタから読み込みます。
     * @param fd ファイルディスクリプタ
     * @param count 読み込む最大サイズ
     */
    public async read(fd: number, count: number = Infinity): Promise<ArrayBuffer> {
        const fdd = this._requireFileDescriptorData(fd);

        if (!(fdd.flags & OpenFlag.READ)) {
            throw new EBADFD();
        }

        const entry = this.filesystem.get(resolve(fdd.pathname, this.env.PWD), true);
        if (isDirectory(entry)) {
            throw new EISDIR(fdd.pathname);
        }

        if (isRegularFile(entry) || isExecutableFile(entry)) {
            if (!entry.data) entry.data = generateFakeElfFile();
            const data = entry.data.slice(fdd.offset, fdd.offset + count);
            this.seek(fd, fdd.offset + data.byteLength);
            return data;
        } else if (isDeviceFile(entry)) {
            return await entry.read();
        } else {
            throw new EIO();
        }
    }
    /**
     * ファイルディスクリプタに書き込みます。
     * @param fd ファイルディスクリプタ
     * @param buf 書き込むバッファ
     * @param count 書き込む最大サイズ
     */
    public write(fd: number, buf: ArrayBuffer, count: number = Infinity): void {
        const fdd = this._requireFileDescriptorData(fd);

        if (!(fdd.flags & OpenFlag.WRITE)) {
            throw new EBADFD();
        }

        const entry = this.filesystem.get(resolve(fdd.pathname, this.env.PWD), true);
        if (isDirectory(entry)) {
            throw new EISDIR(fdd.pathname);
        }

        if (isRegularFile(entry)) {
            const data = buf.slice(0, count);
            entry.data = concatArrayBuffer(entry.data.slice(0, fdd.offset), data, entry.data.slice(fdd.offset));
            this.seek(fd, fdd.offset + data.byteLength);
        } else if (isDeviceFile(entry)) {
            entry.write(buf);
        } else {
            throw new EIO();
        }
    }

    private _stat(entry: IFile): Stat {
        let mode: number =
            (isDirectory(entry) ? StatMode.IFDIR : 0) |
            (isRegularFile(entry) ? StatMode.IFREG : 0) |
            (isDeviceFile(entry) ? StatMode.IFCHR : 0) |
            (isSymbolicLink(entry) ? StatMode.IFLNK : 0);

        return {
            mode: entry.mode | mode,
            owner: entry.owner,
            group: entry.group,
            size: 0, // TODO: size
            // TODO: ctime, atime, mtime
        };
    }
    /**
     * ファイルの状態を取得します。
     * @param pathname パス名
     */
    public stat(pathname: string): Stat {
        return this._stat(this.filesystem.get(resolve(pathname, this.env.PWD), true));
    }
    /**
     * ファイルディスクリプタからファイルの状態を取得します。
     * @param fd ファイルディスクリプタ
     */
    public fstat(fd: number): Stat {
        const fdd = this._requireFileDescriptorData(fd);
        const entry = this.filesystem.get(resolve(fdd.pathname, this.env.PWD));
        return this._stat(entry);
    }
    /**
     * ファイルの状態を取得します。シンボリックリンクの場合でも、リンクを解決しません。
     * @param pathname パス名
     */
    public lstat(pathname: string): Stat {
        return this._stat(this.filesystem.get(resolve(pathname, this.env.PWD)));
    }

    /**
     * ファイルに削除フラグを立てます。参照しているファイルディスクリプタが存在しない場合、エントリを削除します。
     * @param pathname パス名
     * @param flags フラグ
     */
    public unlink(pathname: string, flags: UnlinkFlag = 0 as UnlinkFlag): void {
        const entry = this.filesystem.get(resolve(pathname, this.env.PWD));
        if (flags & UnlinkFlag.REMOVE_DIR) {
            if (!isDirectory(entry)) {
                throw new ENOTDIR(pathname);
            }

            this.filesystem.delete(pathname, true);
        } else {
            if (isDirectory(entry)) {
                throw new EISDIR(pathname);
            }
        }

        this.filesystem.delete(pathname, false);
    }

    /**
     * ディレクトリを作成します。
     * @param pathname パス名
     * @param mode アクセス権限
     * @param recursive 再帰的に作成するかどうか
     */
    public mkdir(pathname: string, mode: number, recursive: boolean = false): void {
        try {
            this.filesystem.create(dirname(pathname), <Directory>{
                name: basename(pathname),
                type: "directory",
                owner: 0,
                group: 0,
                mode,
                deleted: false,
                children: []
            });
        } catch (e) {
            if (recursive && e instanceof ENOENT) {
                this.mkdir(dirname(pathname), mode, recursive);
                this.mkdir(pathname, mode, recursive);
            } else {
                throw e;
            }
        }
    }
    /**
     * ディレクトリの中に存在するファイル名の一覧を取得します。
     * @param pathname パス名
     */
    public readdir(pathname: string): string[] {
        return this.filesystem.list(PATH_SEPARATOR + join(...resolve(pathname, this.env.PWD)));
    }
    /**
     * ディレクトリを削除します。
     * @param pathname パス名
     */
    public rmdir(pathname: string): void {
        const entry = this.filesystem.get(resolve(pathname, this.env.PWD));
        if (!isDirectory(entry)) {
            throw new ENOTDIR(pathname);
        }

        if (this.filesystem.list(pathname).length > 0) {
            throw new ENOTEMPTY(pathname);
        }

        this.filesystem.delete(pathname);
    }

    /**
     * ファイル名 linkpath で target へのシンボリックリンクを作成します。
     * @param target リンク先
     * @param linkpath シンボリックリンクの名前
     */
    public symlink(target: string, linkpath: string): void {
        this.filesystem.create(this.env.PWD ?? "/", <SymbolicLink>{
            name: linkpath,
            type: "symlink",
            owner: 0,
            group: 0,
            mode: 0o777,
            deleted: false,
            target
        });
    }
    /**
     * シンボリックリンク pathname のリンク先を参照します。
     * @param pathname パス名
     */
    public readlink(pathname: string): string {
        const entry = this.filesystem.get(resolve(pathname, this.env.PWD));
        if (isSymbolicLink(entry)) {
            return entry.target;
        } else {
            throw new EINVAL();
        }
    }

    /**
     * 稼働中のエミュレーターについての名前と情報を取得します。
     */
    public uname(): EmulatorInfo {
        return {
            nodename: this.emulator.parameters["kernel.hostname"],
            os_name: this.emulator.parameters["kernel.ostype"],
            os_version: this.emulator.parameters["kernel.osrelease"]
        };
    }

    private _chown(entry: IFile, owner: number, group: number): void {
        entry.owner = owner;
        entry.group = group;
    }
    /**
     * ファイルの所有権を変更します。
     * @param pathname パス名
     * @param owner ユーザー ID (UID)
     * @param group グループ ID (GID)
     */
    public chown(pathname: string, owner: number, group: number): void {
        return this._chown(this.filesystem.get(resolve(pathname, this.env.PWD), true), owner, group);
    }
    /**
     * ファイルディスクリプタからファイルの所有権を変更します。
     * @param fd ファイルディスクリプタ
     * @param owner ユーザー ID (UID)
     * @param group グループ ID (GID)
     */
    public fchown(fd: number, owner: number, group: number): void {
        const fdd = this._requireFileDescriptorData(fd);
        const entry = this.filesystem.get(resolve(fdd.pathname, this.env.PWD));
        return this._chown(entry, owner, group);
    }
    /**
     * ファイルの所有権を変更します。シンボリックリンクの場合でも、リンクを解決しません。
     * @param pathname パス名
     * @param owner ユーザー ID (UID)
     * @param group グループ ID (GID)
     */
    public lchown(pathname: string, owner: number, group: number): void {
        return this._chown(this.filesystem.get(resolve(pathname, this.env.PWD)), owner, group);
    }

    private _chmod(entry: IFile, mode: number): void {
        entry.mode = mode;
    }
    /**
     * ファイルの権限を変更します。
     * @param pathname パス名
     * @param mode モード
     */
    public chmod(pathname: string, mode: number): void {
        return this._chmod(this.filesystem.get(resolve(pathname, this.env.PWD), true), mode);
    }
    /**
     * ファイルディスクリプタからファイルの権限を変更します。
     * @param fd ファイルディスクリプタ
     * @param mode モード
     */
    public fchmod(fd: number, mode: number): void {
        const fdd = this._requireFileDescriptorData(fd);
        const entry = this.filesystem.get(resolve(fdd.pathname, this.env.PWD));
        return this._chmod(entry, mode);
    }

    /**
     * このプロセスが動作しているユーザー IDを取得します。
     */
    public getuid(): number {
        return this.uid;
    }
    /**
     * このプロセスが動作しているユーザー IDを設定します。
     * @param uid ユーザー ID
     */
    public setuid(uid: number): void {
        // TODO: EPERM, rw**s**, https://qiita.com/pyon_kiti_jp/items/9918dcfc6a350fd007b1
        this.uid = uid;
    }
    /**
     * このプロセスが動作しているグループ IDを取得します。
     */
    public getgid(): number {
        return this.gid;
    }
    /**
     * このプロセスが動作しているグループ IDを設定します。
     * @param gid グループ ID
     */
    public setgid(gid: number): void {
        // TODO: EPERM, rw**s**, https://qiita.com/pyon_kiti_jp/items/9918dcfc6a350fd007b1
        this.gid = gid;
    }

    /**
     * プロセスを新しく生成します。
     * @param callback 実行するマイクロプロセス
     */
    public async spawn(callback: (this: Process) => Promise<unknown>): Promise<void> {
        const process = new Process(this.emulator, {
            id: this.emulator.newPid,
            name: "New Process",
            tty: this.tty,
            filesystem: this.filesystem,
            env: this.env,
            uid: this.uid,
            gid: this.gid
        });
        this.emulator.newPid++;
        this.children.push(process);
        process.open("/dev/tty1", OpenFlag.READ);
        process.open("/dev/tty1", OpenFlag.WRITE);
        process.open("/dev/tty1", OpenFlag.WRITE);

        await callback.bind(process)();
        this.children = this.children.filter(p => p.id !== process.id);
    }

    /**
     * 現在のプロセスで実行可能ファイルを実行します。
     * @param pathname パス名
     * @param args 引数
     * @param env 環境変数
     */
    public async exec(pathname: string, args: string[] = [], env: ProcessInit["env"] = {}): Promise<any> {
        const entry = this.filesystem.get(resolve(pathname, this.env.PWD), true);

        this.name = pathname;
        // TODO: deep copy
        this.args = args;
        this.env = Object.assign(this.env, Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined)));

        if (isExecutableFile(entry)) {
            // TODO: permission check

            const p = this;
            await entry.onStart.bind(this)({
                io: {
                    async read(fd = 0, flag = StdReadFlag.ECHO | StdReadFlag.READ_LINE) {
                        const instance = new ReadInstance();
                        while (true) {
                            const rawVal = new Uint8Array(await p.read(fd));
                            let strVal = new TextDecoder("utf-8").decode(rawVal);

                            if (flag & StdReadFlag.READ_LINE) {
                                const response = instance.process(rawVal);

                                if (flag & StdReadFlag.ECHO) {
                                    this.write(response);
                                }

                                if (instance.hasEnded) {
                                    if (!(flag & StdReadFlag.ECHO)) {
                                        this.write("\n");
                                    }
                                    return instance.line;
                                }
                            } else {
                                if (flag & StdReadFlag.ECHO) {
                                    this.write(strVal);
                                }

                                return strVal;
                            }
                        }
                    },
                    write(val, fd = 1) {
                        p.write(fd, typeof val === "string" ? new TextEncoder().encode(val) : val);
                    },
                },
                path: {
                    absolute: (pathname: string) => PATH_SEPARATOR + join(...resolve(pathname, this.env.PWD))
                }
            });
        } else if (isRegularFile(entry)) {
            // TODO: interpreter script
        } else {
            throw new ELIBBAD(pathname);
        }
    }

}

/** 行読み込みインスタンス */
export class ReadInstance {
    /** バッファ */
    public buffer: { forward: string; backward: string; };
    /** 読み込みが完了したかどうか */
    public hasEnded: boolean;

    public constructor() {
        this.buffer = {
            forward: "",
            backward: ""
        };
        this.hasEnded = false;
    }

    process(value: ArrayBuffer): string {
        const binValue = new Uint8Array(value);
        const chars = [
            ...new TextDecoder("utf-8").decode(binValue)

                // NOTE: 改行コードの吸収
                .replaceAll("\r\n", "\n")
                .replaceAll("\r", "\n")
        ];

        /** エコー文字列 */
        let response = "";
        /** 文字列が消去された等の理由で、右端を空白で埋める必要がある文字数（半角を単位とする） */
        let shiftCount = 0;

        const write = (char: string): void => {
            response += char;
        };
        const bell = (char: string = "\x07"): void => {
            if (!response.includes(char)) response += char;
        };
        const getLength = (str: string): number => {
            // TODO: 2バイト文字対応
            return str.length;
        }

        while (chars.length !== 0) {
            const read = (push: boolean = true): string | undefined => {
                const char = chars.shift();
                if (char === "\x7F" || char === "\x08") {
                    if (this.buffer.backward.length === 0) {
                        bell();
                    } else {
                        // NOTE: サロゲートペアを正しく処理できないので、Unicode オプションを使用した正規表現を用いてバッファの処理を行う
                        const removingChar = this.buffer.backward.match(/(.)$/u)![0];
                        this.buffer.backward = this.buffer.backward.replace(/.$/u, "");

                        const length = getLength(removingChar);
                        shiftCount += length;
                        write(`\x1B[${length}D`);
                    }
                } else if (char === "\x1B") {
                    if (read(false) === "[") {
                        // NOTE: エスケープシーケンスの処理
                        let args: string = "";
                        let command: string | undefined = undefined;
                        while (!command) {
                            const sequenceChar = read(false);
                            if (!sequenceChar) break;

                            const sequenceCharCode = sequenceChar.charCodeAt(0);
                            if (sequenceChar === ";" || 48 <= sequenceCharCode && sequenceCharCode <= 57) {
                                args += sequenceChar;
                            } else {
                                command = sequenceChar;
                            }
                        }

                        if (command === "A" || command === "B") {
                            // TODO: A: Up, B: Down
                        } else if (command === "C") {
                            // NOTE: Right
                            if (this.buffer.forward.length === 0) {
                                bell();
                            } else {
                                const movingChar = this.buffer.forward.match(/^(.)/u)![0];
                                this.buffer.backward += movingChar;
                                this.buffer.forward = this.buffer.forward.replace(/^./u, "");
                                write("\x1B[" + getLength(movingChar) + command);
                            }
                        } else if (command === "D") {
                            // NOTE: Left
                            if (this.buffer.backward.length === 0) {
                                bell();
                            } else {
                                const movingChar = this.buffer.backward.match(/(.)$/u)![0];
                                this.buffer.forward = movingChar + this.buffer.forward;
                                this.buffer.backward = this.buffer.backward.replace(/.$/u, "");
                                write("\x1B[" + getLength(movingChar) + command);
                            }
                        } else if (command === "H") {
                            // NOTE: Home
                            if (this.buffer.backward.length === 0) {
                                bell();
                            } else {
                                const length = getLength(this.buffer.backward);
                                this.buffer.forward = this.buffer.backward + this.buffer.forward;
                                this.buffer.backward = "";
                                write(`\x1B[${length}D`);
                            }
                        } else if (command === "F") {
                            // NOTE: End
                            if (this.buffer.forward.length === 0) {
                                bell();
                            } else {
                                const length = getLength(this.buffer.forward);
                                this.buffer.backward = this.buffer.backward + this.buffer.forward;
                                this.buffer.forward = "";
                                write(`\x1B[${length}C`);
                            }
                        } else {
                            console.log(command, args);
                        }
                    }
                } else if (char === "\n") {
                    // TODO: [改行][バックスペースキー] のパターンも存在する
                    this.hasEnded = true;
                    write(char);
                } else {
                    if (push) this.buffer.backward += char;
                    if (char && push) write(char);
                }
                return char;
            };
            read();
            // console.log(this.buffer.backward + "|" + this.buffer.forward);
            if (this.hasEnded) break;
        }

        return response + (this.buffer.forward.length + shiftCount > 0 ? this.buffer.forward + " ".repeat(shiftCount) + `\x1B[${this.buffer.forward.length + shiftCount}D` : "");
    }

    public get line(): string {
        return this.buffer.backward + this.buffer.forward;
    }
}
