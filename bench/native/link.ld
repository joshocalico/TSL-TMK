ENTRY(c_bench)
SECTIONS {
  . = 0;
  .text : {
    *(.text.entry)
    *(.text .text.*)
    . = ALIGN(16);
    *(.rodata .rodata.*)
    . = ALIGN(16);
    *(.data .data.*)
    . = ALIGN(16);
    *(.bss .bss.*)
    *(COMMON)
    . = ALIGN(16);
    BYTE(0)
  }
  /DISCARD/ : { *(.comment) *(.note*) *(.eh_frame*) }
}
