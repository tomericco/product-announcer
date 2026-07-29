"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { saveIndustry } from "./actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// A broad, standard-style set of industries (aligned with common GICS/NAICS/
// LinkedIn sector groupings). It's a UI convenience list — any custom value is
// allowed, so this doesn't need to be exhaustive.
const INDUSTRIES = [
  // Technology & software
  "Software & Technology",
  "SaaS",
  "Developer Tools",
  "Cloud Infrastructure",
  "IT Services & Consulting",
  "Artificial Intelligence & Machine Learning",
  "Data & Analytics",
  "Cybersecurity",
  "Internet & Web Services",
  "No-Code & Low-Code",
  "Hardware & Electronics",
  "Semiconductors",
  "Robotics & Automation",
  "Internet of Things (IoT)",
  "Augmented & Virtual Reality",
  "Telecommunications",
  "Gaming",
  // Finance
  "Fintech",
  "Financial Services",
  "Banking",
  "Payments",
  "Lending & Credit",
  "Insurance",
  "Investment & Asset Management",
  "Wealth Management",
  "Venture Capital & Private Equity",
  "Accounting",
  "Cryptocurrency & Blockchain",
  // Health & life sciences
  "Healthcare",
  "Telemedicine",
  "Biotech & Pharmaceuticals",
  "Medical Devices",
  "Mental Health & Wellness",
  "Fitness",
  "Veterinary",
  "Elder & Home Care",
  // Commerce & consumer
  "E-commerce",
  "Retail",
  "Online Marketplaces",
  "Consumer Goods",
  "Food & Beverage",
  "Grocery",
  "Restaurants & Food Service",
  "Fashion & Apparel",
  "Beauty & Cosmetics",
  "Luxury Goods",
  "Furniture & Home Goods",
  // Media, marketing & creative
  "Media & Entertainment",
  "Publishing",
  "News & Journalism",
  "Music",
  "Film & Video",
  "Streaming",
  "Podcasting",
  "Marketing & Advertising",
  "Public Relations",
  "Social Media",
  "Design & Creative Services",
  "Photography",
  // Industrial & manufacturing
  "Manufacturing",
  "Automotive",
  "Aerospace & Defense",
  "Aviation",
  "Maritime & Shipping",
  "Rail & Transit",
  "Construction",
  "Engineering Services",
  "Architecture",
  "Industrial Equipment & Machinery",
  "Packaging",
  "Textiles",
  // Energy, environment & resources
  "Energy & Utilities",
  "Oil & Gas",
  "Renewable Energy",
  "Mining & Metals",
  "Chemicals",
  "Water & Waste Management",
  "Environmental Services",
  "Agriculture",
  "AgTech",
  "Forestry & Fishing",
  // Services & public sector
  "Education",
  "E-learning",
  "Real Estate",
  "PropTech",
  "Transportation & Logistics",
  "Supply Chain",
  "Travel & Hospitality",
  "Legal",
  "Human Resources & Recruiting",
  "Staffing",
  "Consulting & Professional Services",
  "Market Research",
  "Government & Public Sector",
  "Defense & Military",
  "Nonprofit & NGO",
  "Emergency & Public Safety",
  "Facilities & Property Management",
  "Sports",
  "Events & Conferences",
];

export function IndustrySelect({ defaultValue }: { defaultValue: string }) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const q = query.trim();
  const filtered = q ? INDUSTRIES.filter((i) => i.toLowerCase().includes(q.toLowerCase())) : INDUSTRIES;
  const exactMatch = INDUSTRIES.some((i) => i.toLowerCase() === q.toLowerCase());
  const showCustom = q.length > 0 && !exactMatch;

  // Picking an industry is the save -- this card has no button of its own.
  const select = async (v: string) => {
    setValue(v);
    setOpen(false);
    setQuery("");
    try {
      await saveIndustry(v);
      // No success toast: this card has no Save button, and confirming every
      // pick would be noise. The chosen value showing in the trigger is the
      // confirmation. Failures still speak up below.
    } catch {
      // The optimistic value stays on screen, so say plainly that it didn't
      // stick -- a silent failure here looks identical to a successful save.
      toast.error("Couldn't save the industry — try again");
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      return;
    }
    // cmdk scrolls its selected item into view on mount (and again as items
    // register). Inside a portaled popover that scrollIntoView bubbles to the
    // document and jumps the whole page. Revert any *window* scroll during the
    // open transition — the list's own internal scroll to the selected item is
    // an element scroll and is unaffected.
    const { scrollX, scrollY } = window;
    const pin = () => window.scrollTo(scrollX, scrollY);
    window.addEventListener("scroll", pin);
    window.setTimeout(() => window.removeEventListener("scroll", pin), 400);
  };

  return (
    <>
      {/* No hidden input: this card is no longer inside a form. `select` writes
          through the saveIndustry Server Action. */}
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          render={
            <Button type="button" variant="outline" role="combobox" className="w-full justify-between font-normal" />
          }
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || "Select an industry"}
          </span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-(--anchor-width) p-0">
          {/* cmdk filtering is disabled so we can always surface a "use custom value" row. */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search or type a custom industry…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {filtered.length === 0 && !showCustom && <CommandEmpty>No industry found.</CommandEmpty>}
              {showCustom && (
                <CommandGroup>
                  <CommandItem value={`custom:${q}`} onSelect={() => select(q)}>
                    <Check className={cn("mr-2 size-4", value === q ? "opacity-100" : "opacity-0")} />
                    Use &ldquo;{q}&rdquo;
                  </CommandItem>
                </CommandGroup>
              )}
              <CommandGroup>
                {filtered.map((i) => (
                  <CommandItem key={i} value={i} onSelect={() => select(i)}>
                    <Check className={cn("mr-2 size-4", value === i ? "opacity-100" : "opacity-0")} />
                    {i}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
