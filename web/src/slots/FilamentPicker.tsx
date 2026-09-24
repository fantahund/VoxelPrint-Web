import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Dialog,
  Flex,
  ScrollArea,
  Select,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import {
  closest,
  colourOf,
  distance,
  loadLibrary,
  materialsOf,
  nearest,
  ofMaterial,
  search,
  type Library,
  type LibraryColour,
} from "./library";
import type { FilamentSlot } from "./filament";

/**
 * Choosing a real spool instead of a colour off a wheel.
 *
 * <p>Two things at once, because they are the same question asked twice. One
 * slot at a time: which of this maker's spools is this filament? And all of
 * them at once: I own a shelf of Bambu, put the whole build on what I have.
 * The second is the one that matters -- a build painted in colours nobody
 * sells is a build that cannot be printed as it looks.
 *
 * <p>The list opens sorted by how near each spool is to the colour the slot
 * already has, which is almost always the answer. Typing searches instead.
 */

/** How many swatches to draw at once. Beyond this nobody is reading anyway. */
const SHOWN = 240;

/** Past this in Oklab a match is a different colour, and says so. */
const OFF = 0.06;

export default function FilamentPicker({
  open,
  onOpenChange,
  slots,
  slot,
  onPick,
  onPickAll,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slots: readonly FilamentSlot[];
  /** Which filament is being chosen, or null to choose for all of them. */
  slot: number | null;
  onPick: (index: number, colour: LibraryColour) => void;
  /** Snap every slot to its nearest spool among these. */
  onPickAll: (colours: readonly LibraryColour[]) => void;
}): React.ReactElement {
  const [library, setLibrary] = useState<Library | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [brandName, setBrandName] = useState<string | null>(null);
  /**
   * Which material, because a print is made of one.
   *
   * <p>PLA and PETG want different temperatures and barely stick to each
   * other, so a plan that mixes them is a plan for something that comes apart.
   * There is no "any": the widest range the maker has is chosen for you, and
   * changing it is a deliberate act.
   */
  const [material, setMaterial] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Loaded the first time somebody opens this, and then kept.
  useEffect(() => {
    if (!open || library !== null) {
      return;
    }
    let cancelled = false;
    void loadLibrary()
      .then((loaded) => {
        if (!cancelled) {
          setLibrary(loaded);
          setBrandName((current) => current ?? loaded.brands[0]?.name ?? null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setFailure(cause instanceof Error ? cause.message : "The library could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, library]);

  const brand = useMemo(
    () => library?.brands.find((one) => one.name === brandName) ?? null,
    [library, brandName],
  );

  const materials = useMemo(() => (brand === null ? [] : materialsOf(brand)), [brand]);

  // A maker who does not sell the material that was chosen gets their own
  // widest range instead, which for almost everybody is PLA.
  useEffect(() => {
    if (materials.length === 0) {
      return;
    }
    if (material === null || !materials.some((one) => one.name === material)) {
      setMaterial(materials[0]?.name ?? null);
    }
  }, [materials, material]);

  /** What the picking happens among: one maker, one material. */
  const pool = useMemo(
    () => (brand === null ? [] : ofMaterial(brand, material)),
    [brand, material],
  );

  const want = slot === null ? null : slots[slot]?.colour ?? 0x9a9a9a;

  const shown = useMemo(() => {
    if (query.trim() !== "") {
      return search(pool, query).slice(0, SHOWN);
    }
    // No search: nearest to the colour this slot already has, which is what
    // somebody opening it is looking for.
    return want === null ? pool.slice(0, SHOWN) : nearest(pool, want, SHOWN);
  }, [pool, query, want]);

  const matches = useMemo(() => slots.map((one) => closest(pool, one.colour)), [pool, slots]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="44rem">
        <Dialog.Title size="4">
          {slot === null ? "Put the build on filament you can buy" : `Filament ${slot + 1}`}
        </Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          {library === null
            ? "Reading the library…"
            : `${library.brands.length} makers from the ${library.source}, ${library.version}.`}
        </Dialog.Description>

        {failure !== null && (
          <Callout.Root size="1" color="red" mb="3">
            <Callout.Text>{failure}</Callout.Text>
          </Callout.Root>
        )}

        {library === null && failure === null && (
          <Flex align="center" gap="2" py="4" justify="center">
            <Spinner />
            <Text size="2" color="gray">
              Loading
            </Text>
          </Flex>
        )}

        {library !== null && (
          <Flex direction="column" gap="3">
            <Flex gap="2" wrap="wrap" align="center">
              <Select.Root value={brandName ?? ""} onValueChange={setBrandName}>
                <Select.Trigger placeholder="Maker" style={{ minWidth: "12rem" }} />
                <Select.Content position="popper">
                  {library.brands.map((one) => (
                    <Select.Item key={one.name} value={one.name}>
                      {one.name} ({one.colours.length})
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>

              <Select.Root
                value={material ?? ""}
                onValueChange={setMaterial}
                disabled={materials.length === 0}
              >
                <Select.Trigger placeholder="Material" style={{ minWidth: "8rem" }} />
                <Select.Content position="popper">
                  {materials.map((one) => (
                    <Select.Item key={one.name} value={one.name}>
                      {one.name} ({one.count})
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>

              {slot !== null && (
                <TextField.Root
                  size="2"
                  style={{ flex: 1, minWidth: "10rem" }}
                  placeholder="Search"
                  value={query}
                  aria-label="Search the colours"
                  onChange={(event) => setQuery(event.target.value)}
                />
              )}
            </Flex>

            <Text as="p" size="1" color="gray">
              One material for the whole print: PLA and PETG want different
              temperatures and barely stick to each other.
            </Text>

            {slot === null ? (
              <>
                <Text as="p" size="2" color="gray">
                  Every filament moves to the nearest {material ?? ""} spool{" "}
                  {brand?.name ?? "this maker"} sells. The build keeps the colours it was
                  planned in until you say so.
                </Text>
                <Flex direction="column" gap="1">
                  {slots.map((one, index) => {
                    const match = matches[index] ?? null;
                    const off = match === null ? 0 : distance(match, one.colour);
                    return (
                      <Flex key={index} align="center" gap="2">
                        <Swatch colour={one.colour} />
                        <Text size="1" color="gray" style={{ width: "1.5rem" }}>
                          {"→"}
                        </Text>
                        <Swatch colour={match === null ? one.colour : colourOf(match)} />
                        <Text size="1" truncate style={{ flex: 1, minWidth: 0 }}>
                          {match === null ? "nothing to match" : `${match.name} — ${match.product}`}
                        </Text>
                        {match !== null && off > OFF && (
                          <Badge size="1" color="amber">
                            off by {(off * 100).toFixed(0)}
                          </Badge>
                        )}
                      </Flex>
                    );
                  })}
                </Flex>
                <Flex gap="2" justify="end">
                  <Dialog.Close>
                    <Button variant="soft" color="gray">
                      Leave it
                    </Button>
                  </Dialog.Close>
                  <Button
                    disabled={pool.length === 0}
                    onClick={() => {
                      onPickAll(pool);
                      onOpenChange(false);
                    }}
                  >
                    Use {brand?.name ?? "these"} {material ?? ""}
                  </Button>
                </Flex>
              </>
            ) : (
              <>
                <ScrollArea style={{ height: "22rem" }}>
                  <Flex direction="column" gap="1" pr="3">
                    {shown.map((colour) => (
                      <Flex
                        key={`${colour.product}|${colour.hex}|${colour.name}`}
                        align="center"
                        gap="2"
                        px="1"
                        py="1"
                        style={{ borderRadius: "var(--radius-2)", cursor: "pointer" }}
                        onClick={() => {
                          onPick(slot, colour);
                          onOpenChange(false);
                        }}
                      >
                        <Swatch colour={colourOf(colour)} />
                        <Text size="2" truncate style={{ flex: 1, minWidth: 0 }}>
                          {colour.name}
                        </Text>
                        <Text size="1" color="gray" truncate style={{ maxWidth: "11rem" }}>
                          {colour.product}
                        </Text>
                        {colour.discontinued === true && (
                          <Badge size="1" color="gray">
                            gone
                          </Badge>
                        )}
                      </Flex>
                    ))}
                    {shown.length === 0 && (
                      <Text size="2" color="gray">
                        No {material ?? ""} of {brand?.name ?? "this maker"} matches that.
                      </Text>
                    )}
                  </Flex>
                </ScrollArea>
                <Text as="p" size="1" color="gray">
                  {query.trim() === ""
                    ? `The ${Math.min(SHOWN, shown.length)} nearest to what this filament is set to now.`
                    : `${shown.length}${shown.length === SHOWN ? " or more" : ""} matching "${query.trim()}".`}
                </Text>
              </>
            )}
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function Swatch({ colour }: { colour: number }): React.ReactElement {
  return (
    <Box
      style={{
        width: "1.5rem",
        height: "1.5rem",
        flex: "0 0 auto",
        borderRadius: "var(--radius-2)",
        background: `#${(colour & 0xffffff).toString(16).padStart(6, "0")}`,
        border: "1px solid var(--gray-a6)",
      }}
    />
  );
}
