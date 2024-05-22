import { Filesystem } from "./Filesystem";
import { Process } from "./Process";

export interface IFile {
    owner: number;
    group: number;
    mode: number;
}

export interface RegularFile extends IFile {
    type: "regular-file";
    data: ArrayBuffer;
}

export interface ExecutableFile extends IFile {
    type: "executable-file";
    data?: ArrayBuffer;

    onStart(this: Process, lib: {
        io: {
            read: (fd?: number, flag?: number) => Promise<string>;
            write: (val: string | Uint8Array, fd?: number) => void;
        },
        path: {
            absolute: (pathname: string) => string;
        }
    }): Promise<void>;
}

export interface DeviceFile extends IFile {
    type: "device";

    read(): ArrayBuffer | Promise<ArrayBuffer>;
    write(data: ArrayBuffer): void;
}

export interface SymbolicLink extends IFile {
    type: "symlink";

    target: string;
}

export interface FilesystemFile extends IFile {
    type: "filesystem";

    target: Filesystem;
}

export interface Directory extends IFile {
    type: "directory";
}

export type File = RegularFile | ExecutableFile | DeviceFile | SymbolicLink | FilesystemFile | Directory;

export function getFileType(value: IFile): string {
    return "type" in value ? <string>value.type : "unknown";
}
export function isRegularFile(value: IFile): value is RegularFile {
    return getFileType(value) === "regular-file";
}
export function isExecutableFile(value: IFile): value is ExecutableFile {
    return getFileType(value) === "executable-file";
}
export function isDeviceFile(value: IFile): value is DeviceFile {
    return getFileType(value) === "device";
}
export function isSymbolicLink(value: IFile): value is SymbolicLink {
    return getFileType(value) === "symlink";
}
export function isFilesystemFile(value: IFile): value is FilesystemFile {
    return getFileType(value) === "filesystem";
}
export function isDirectory(value: IFile): value is Directory {
    return getFileType(value) === "directory";
}
